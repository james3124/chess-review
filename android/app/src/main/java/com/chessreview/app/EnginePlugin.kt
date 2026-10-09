package com.chessreview.app

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * EnginePlugin — runs the bundled Stockfish binary and exposes UCI analysis
 * to the WebView.
 *
 * The engine ships as jniLibs/arm64-v8a/libstockfishengine.so, so Android
 * extracts it to nativeLibraryDir where it can be executed directly.
 *
 * IMPORTANT: this is the Android sibling of lib/engine.mjs. The ARM64
 * "universal" build loads its ~109MiB embedded NNUE net LAZILY, triggered by
 * the first `go`, and `isready` does NOT wait for it. A search issued during
 * the load returns a fake result:
 *
 *     info depth 1 seldepth 0 multipv 1 score cp 0 nodes 0 ... pv
 *     bestmove a2a3
 *
 * So every search is validated (nodes > 5 AND a non-empty PV); a fake one
 * triggers a health-check retry until the engine is really searching.
 */
@CapacitorPlugin(name = "EnginePlugin")
class EnginePlugin : Plugin() {

    private data class Info(
        val depth: Int = 0, val seldepth: Int = 0, val multipv: Int = 1,
        val scoreCp: Int? = null, val scoreMate: Int? = null,
        val nodes: Long = 0, val timeMs: Long = 0, val pv: List<String> = emptyList()
    )

    private class SearchResult(val best: String?, val ponder: String?, val infos: List<Info>) {
        /** `info` lines arrive in increasing depth, so the last one wins. */
        val bestLine: Info? get() = infos.lastOrNull { it.pv.isNotEmpty() }
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val queues: MutableList<LinkedBlockingQueue<String>> = java.util.Collections.synchronizedList(ArrayList())

    @Volatile private var proc: Process? = null
    private var writer: BufferedWriter? = null
    private val startLock = Any()

    private fun engineFile(): File = File(context.applicationInfo.nativeLibraryDir, "libstockfishengine.so")

    /* ------------------------------------------------------------------ */
    /* process plumbing                                                    */
    /* ------------------------------------------------------------------ */

    private fun send(cmd: String) {
        val w = writer ?: throw IllegalStateException("engine not running")
        w.write(cmd)
        w.newLine()
        w.flush()
    }

    private fun dispatch(line: String) {
        synchronized(queues) { for (q in queues) q.offer(line) }
    }

    /** Reads every `info` line until `bestmove`, with a wall-clock budget. */
    private fun runSearch(positionCmd: String, goCmd: String, budgetMs: Long = 120_000): SearchResult {
        val q = LinkedBlockingQueue<String>()
        synchronized(queues) { queues.add(q) }
        val infos = ArrayList<Info>()
        var best: String? = null
        var ponder: String? = null
        try {
            send(positionCmd)
            send(goCmd)
            val deadline = System.currentTimeMillis() + budgetMs
            while (true) {
                val line = q.poll(120, TimeUnit.MILLISECONDS)
                if (line == null) {
                    if (System.currentTimeMillis() > deadline) break else continue
                }
                if (line.startsWith("bestmove")) {
                    val t = line.split(Regex("\\s+"))
                    best = t.getOrNull(1)
                    val pi = t.indexOf("ponder")
                    if (pi >= 0) ponder = t.getOrNull(pi + 1)
                    break
                }
                parseInfo(line)?.let { infos.add(it) }
            }
        } finally {
            synchronized(queues) { queues.remove(q) }
        }
        return SearchResult(best, ponder, infos)
    }

    private fun parseInfo(line: String): Info? {
        if (!line.startsWith("info ")) return null
        val t = line.split(Regex("\\s+"))
        var depth = 0; var seldepth = 0; var multipv = 1
        var cp: Int? = null; var mate: Int? = null
        var nodes = 0L; var time = 0L
        val pv = ArrayList<String>()
        var i = 1
        while (i < t.size) {
            when (t[i]) {
                "depth" -> { depth = t.getOrNull(i + 1)?.toIntOrNull() ?: 0; i += 2 }
                "seldepth" -> { seldepth = t.getOrNull(i + 1)?.toIntOrNull() ?: 0; i += 2 }
                "multipv" -> { multipv = t.getOrNull(i + 1)?.toIntOrNull() ?: 1; i += 2 }
                "score" -> when (t.getOrNull(i + 1)) {
                    "cp" -> { cp = t.getOrNull(i + 2)?.toIntOrNull(); i += 3 }
                    "mate" -> { mate = t.getOrNull(i + 2)?.toIntOrNull(); i += 3 }
                    else -> i += 1
                }
                "nodes" -> { nodes = t.getOrNull(i + 1)?.toLongOrNull() ?: 0L; i += 2 }
                "time" -> { time = t.getOrNull(i + 1)?.toLongOrNull() ?: 0L; i += 2 }
                "pv" -> { for (j in i + 1 until t.size) pv.add(t[j]); break }
                else -> i += 1
            }
        }
        return Info(depth, seldepth, multipv, cp, mate, nodes, time, pv)
    }

    /* ------------------------------------------------------------------ */
    /* lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    private fun ensureStarted() {
        val existing = proc
        if (existing != null && existing.isAlive) return

        synchronized(startLock) {
            val again = proc
            if (again != null && again.isAlive) return

            val bin = engineFile()
            if (!bin.exists()) throw IllegalStateException("engine binary not found at ${bin.absolutePath}")
            if (!bin.canExecute()) bin.setExecutable(true, false)

            val p = ProcessBuilder(bin.absolutePath).redirectErrorStream(true).start()
            proc = p
            writer = BufferedWriter(OutputStreamWriter(p.outputStream))
            Thread {
                try {
                    BufferedReader(InputStreamReader(p.inputStream)).forEachLine { dispatch(it) }
                } catch (_: Exception) {
                }
            }.also { it.isDaemon = true }.start()

            sendAndExpect("uci", { it == "uciok" }, 30_000, "uciok")
            send("setoption name Threads value 2")
            send("setoption name Hash value 128")
            send("setoption name MultiPV value 2")
            send("ucinewgame")
            send("position startpos")
            // the NNUE load is triggered by the first `go`; retry until real
            var healthy = false
            for (attempt in 1..15) {
                val r = runSearch("position startpos", "go depth 2", 60_000)
                if (!broken(r)) { healthy = true; break }
                Thread.sleep(600)
            }
            if (!healthy) throw IllegalStateException("engine never produced a real search")
        }
    }

    private fun broken(r: SearchResult): Boolean {
        if (r.best == "(none)") return false // checkmate/stalemate: nothing to search
        val l = r.bestLine ?: return true
        return !(l.nodes > 5 && l.pv.isNotEmpty())
    }

    /** Sends a command, then waits for a matching reply.
     * The queue MUST be registered before sending, or the reply is lost. */
    private fun sendAndExpect(cmd: String, pred: (String) -> Boolean, timeoutMs: Long, what: String): String {
        val q = LinkedBlockingQueue<String>()
        synchronized(queues) { queues.add(q) }
        try {
            send(cmd)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val line = q.poll(150, TimeUnit.MILLISECONDS)
                if (line != null && pred(line)) return line
            }
            throw IllegalStateException("timeout waiting for $what")
        } finally {
            synchronized(queues) { queues.remove(q) }
        }
    }

    override fun handleOnDestroy() {        try { proc?.destroy() } catch (_: Exception) {}
        proc = null
        writer = null
        executor.shutdownNow()
    }

    /* ------------------------------------------------------------------ */
    /* API                                                                 */
    /* ------------------------------------------------------------------ */

    /** Warms the engine up (loading the 109MiB NNUE takes a few seconds). */
    @PluginMethod
    fun warmUp(call: PluginCall) {
        executor.execute {
            try {
                ensureStarted()
                activity.runOnUiThread { call.resolve(JSObject().put("ready", true)) }
            } catch (e: Exception) {
                activity.runOnUiThread { call.reject(e.message ?: "engine init failed") }
            }
        }
    }

    @PluginMethod
    fun engineInfo(call: PluginCall) {
        val info = JSObject().put("ready", proc?.isAlive == true)
            .put("binary", engineFile().absolutePath)
            .put("binaryPresent", engineFile().exists())
            .put("threads", 2).put("hash", 128).put("multiPv", 2)
        executor.execute {
            try {
                ensureStarted()
                activity.runOnUiThread { call.resolve(info.put("state", "ready")) }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    call.resolve(info.put("state", "failed").put("error", e.message))
                }
            }
        }
    }

    @PluginMethod
    fun analyzePosition(call: PluginCall) {
        val fen = call.getString("fen")
        if (fen.isNullOrBlank()) { call.reject("missing fen"); return }
        val depth = call.getInt("depth") ?: 0
        val movetime = call.getInt("movetime") ?: 0

        executor.execute {
            try {
                ensureStarted()
                val go = if (depth > 0) "go depth $depth" else "go movetime ${if (movetime > 0) movetime else 300}"
                var r = runSearch("position fen $fen", go)
                var guard = 0
                while (broken(r) && guard < 3) {
                    guard++
                    Thread.sleep(700)
                    r = runSearch("position fen $fen", go)
                }
                if (broken(r)) throw IllegalStateException("analysis produced no real search")
                val res = toJson(r)
                activity.runOnUiThread { call.resolve(res) }
            } catch (e: Exception) {
                activity.runOnUiThread { call.reject(e.message ?: "engine error") }
            }
        }
    }

    private fun toJson(r: SearchResult): JSObject {
        val out = JSObject()
        out.put("best", r.best)
        out.put("ponder", r.ponder)

        // deepest line per multipv
        val best = HashMap<Int, Info>()
        for (i in r.infos) {
            if (i.pv.isEmpty()) continue
            val cur = best[i.multipv]
            if (cur == null || i.depth > cur.depth) best[i.multipv] = i
        }
        val arr = JSArray()
        for ((mp, i) in best.entries.sortedBy { it.key }) {
            val o = JSObject()
            o.put("multipv", mp)
            o.put("depth", i.depth)
            o.put("nodes", i.nodes)
            o.put("time", i.timeMs)
            if (i.scoreCp != null) o.put("scoreCp", i.scoreCp) else if (i.scoreMate != null) o.put("scoreMate", i.scoreMate)
            o.put("pv", JSArray(i.pv.toList()))
            arr.put(o)
        }
        out.put("lines", arr)
        return out
    }
}
