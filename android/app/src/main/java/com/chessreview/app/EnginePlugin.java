package com.chessreview.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * EnginePlugin — runs the bundled Stockfish binary and exposes UCI analysis
 * to the WebView.
 *
 * The engine ships as jniLibs/arm64-v8a/libstockfishengine.so, so Android
 * extracts it to nativeLibraryDir where it can be executed directly.
 *
 * This is the Android sibling of the Node bridge (lib/engine.mjs). The arm64
 * "universal" build loads its ~109MiB embedded NNUE net LAZILY — triggered by
 * the first `go`, and `isready` does NOT wait for it. A search issued during
 * the load returns a fake result instead of failing:
 *
 *     info depth 1 seldepth 0 multipv 1 score cp 0 nodes 0 ... pv
 *     bestmove a2a3
 *
 * So every search is validated (nodes > 5 AND a non-empty PV); a fake one
 * triggers a health-check retry until the engine is really searching.
 */
@CapacitorPlugin(name = "EnginePlugin")
public class EnginePlugin extends Plugin {

    private static final int THREADS = 2;
    private static final int HASH_MB = 128;

    /** One parsed UCI `info` line. */
    private static class Info {
        int depth, seldepth, multipv = 1;
        Integer scoreCp, scoreMate;
        long nodes, timeMs;
        final List<String> pv = new ArrayList<>();
    }

    private final List<LinkedBlockingQueue<String>> queues =
            Collections.synchronizedList(new ArrayList<>());
    private final Object startLock = new Object();
    private final java.util.concurrent.ExecutorService executor =
            Executors.newSingleThreadExecutor();

    private volatile Process proc;
    private BufferedWriter writer;

    /* ------------------------------------------------------------------ */
    /* process plumbing                                                    */
    /* ------------------------------------------------------------------ */

    private File engineFile() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libstockfishengine.so");
    }

    private void send(String cmd) throws Exception {
        BufferedWriter w = writer;
        if (w == null) throw new IllegalStateException("engine not running");
        w.write(cmd);
        w.newLine();
        w.flush();
    }

    private void dispatch(String line) {
        synchronized (queues) {
            for (LinkedBlockingQueue<String> q : queues) q.offer(line);
        }
    }

    /** Reads every `info` line until `bestmove`, with a wall-clock budget. */
    private SearchResult runSearch(String positionCmd, String goCmd, long budgetMs) {
        LinkedBlockingQueue<String> q = new LinkedBlockingQueue<>();
        List<Info> infos = new ArrayList<>();
        String best = null, ponder = null;
        synchronized (queues) { queues.add(q); }
        try {
            send(positionCmd);
            send(goCmd);
            long deadline = System.currentTimeMillis() + budgetMs;
            while (true) {
                String line = q.poll(120, TimeUnit.MILLISECONDS);
                if (line == null) {
                    if (System.currentTimeMillis() > deadline) break;
                    continue;
                }
                if (line.startsWith("bestmove")) {
                    String[] t = line.split("\\s+");
                    if (t.length > 1) best = t[1];
                    for (int i = 0; i < t.length - 1; i++) {
                        if ("ponder".equals(t[i])) ponder = t[i + 1];
                    }
                    break;
                }
                Info i = parseInfo(line);
                if (i != null) infos.add(i);
            }
        } catch (Exception e) {
            // engine died mid-search; return whatever we have
        } finally {
            synchronized (queues) { queues.remove(q); }
        }
        return new SearchResult(best, ponder, infos);
    }

    private static Info parseInfo(String line) {
        if (line == null || !line.startsWith("info ")) return null;
        String[] t = line.split("\\s+");
        Info o = new Info();
        int i = 1;
        while (i < t.length) {
            switch (t[i]) {
                case "depth":
                    o.depth = intAt(t, i + 1, 0); i += 2; break;
                case "seldepth":
                    o.seldepth = intAt(t, i + 1, 0); i += 2; break;
                case "multipv":
                    o.multipv = intAt(t, i + 1, 1); i += 2; break;
                case "score":
                    if ("cp".equals(at(t, i + 1))) { o.scoreCp = intAt(t, i + 2, 0); i += 3; }
                    else if ("mate".equals(at(t, i + 1))) { o.scoreMate = intAt(t, i + 2, 0); i += 3; }
                    else i += 1;
                    break;
                case "nodes":
                    o.nodes = longAt(t, i + 1); i += 2; break;
                case "time":
                    o.timeMs = longAt(t, i + 1); i += 2; break;
                case "pv":
                    for (int j = i + 1; j < t.length; j++) o.pv.add(t[j]);
                    i = t.length;
                    break;
                default: i += 1; break;
            }
        }
        return o;
    }

    private static String at(String[] t, int i) { return i >= 0 && i < t.length ? t[i] : null; }
    private static int intAt(String[] t, int i, int dflt) {
        try { return Integer.parseInt(at(t, i)); } catch (Exception e) { return dflt; }
    }
    private static long longAt(String[] t, int i) {
        try { return Long.parseLong(at(t, i)); } catch (Exception e) { return 0L; }
    }

    private static class SearchResult {
        final String best, ponder;
        final List<Info> infos;

        SearchResult(String best, String ponder, List<Info> infos) {
            this.best = best; this.ponder = ponder; this.infos = infos;
        }

        /** `info` lines arrive in increasing depth, so the last one wins. */
        Info bestLine() {
            for (int i = infos.size() - 1; i >= 0; i--) {
                if (!infos.get(i).pv.isEmpty()) return infos.get(i);
            }
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    private void ensureStarted() throws Exception {
        Process existing = proc;
        if (existing != null && existing.isAlive()) return;

        synchronized (startLock) {
            Process again = proc;
            if (again != null && again.isAlive()) return;

            File bin = engineFile();
            if (!bin.exists()) throw new IllegalStateException("engine binary not found at " + bin.getAbsolutePath());
            if (!bin.canExecute()) bin.setExecutable(true, false);

            Process p = new ProcessBuilder(bin.getAbsolutePath())
                    .redirectErrorStream(true).start();
            proc = p;
            writer = new BufferedWriter(new OutputStreamWriter(p.getOutputStream()));
            Thread reader = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                    String line;
                    while ((line = r.readLine()) != null) dispatch(line);
                } catch (Exception ignored) { }
            });
            reader.setDaemon(true);
            reader.start();

            sendAndExpect("uci", l -> l.equals("uciok"), 30000, "uciok");
            send("setoption name Threads value " + THREADS);
            send("setoption name Hash value " + HASH_MB);
            send("setoption name MultiPV value 2");
            send("ucinewgame");
            send("position startpos");

            // the NNUE load is triggered by the first `go`; retry until real
            boolean healthy = false;
            for (int attempt = 1; attempt <= 15; attempt++) {
                SearchResult r = runSearch("position startpos", "go depth 2", 60000);
                if (!broken(r)) { healthy = true; break; }
                Thread.sleep(600);
            }
            if (!healthy) throw new IllegalStateException("engine never produced a real search");
        }
    }

    private boolean broken(SearchResult r) {
        if ("(none)".equals(r.best)) return false; // checkmate/stalemate: nothing to search
        Info l = r.bestLine();
        return l == null || !(l.nodes > 5 && !l.pv.isEmpty());
    }

    /** Sends a command, then waits for a matching reply.
     * The queue MUST be registered before sending, or the reply is lost. */
    private String sendAndExpect(String cmd, java.util.function.Predicate<String> pred,
                                long timeoutMs, String what) throws Exception {
        LinkedBlockingQueue<String> q = new LinkedBlockingQueue<>();
        synchronized (queues) { queues.add(q); }
        try {
            send(cmd);
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                String line = q.poll(150, TimeUnit.MILLISECONDS);
                if (line != null && pred.test(line)) return line;
            }
            throw new IllegalStateException("timeout waiting for " + what);
        } finally {
            synchronized (queues) { queues.remove(q); }
        }
    }

    @Override
    protected void handleOnDestroy() {
        try { if (proc != null) proc.destroy(); } catch (Exception ignored) { }
        proc = null;
        writer = null;
        executor.shutdownNow();
    }

    /* ------------------------------------------------------------------ */
    /* API                                                                 */
    /* ------------------------------------------------------------------ */

    /** Warms the engine up (loading the 109MiB NNUE takes a few seconds). */
    @PluginMethod
    public void warmUp(PluginCall call) {
        executor.execute(() -> {
            try {
                ensureStarted();
                bridge.getActivity().runOnUiThread(() -> call.resolve(new JSObject().put("ready", true)));
            } catch (Exception e) {
                bridge.getActivity().runOnUiThread(() -> call.reject(e.getMessage() == null ? "engine init failed" : e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void engineInfo(PluginCall call) {
        JSObject info = new JSObject()
                .put("ready", proc != null && proc.isAlive())
                .put("binary", engineFile().getAbsolutePath())
                .put("binaryPresent", engineFile().exists())
                .put("threads", THREADS)
                .put("hash", HASH_MB)
                .put("multiPv", 2);
        executor.execute(() -> {
            try {
                ensureStarted();
                JSObject out = new JSObject(info.toString());
                bridge.getActivity().runOnUiThread(() -> call.resolve(out.put("state", "ready")));
            } catch (Exception e) {
                JSObject out = new JSObject(info.toString());
                bridge.getActivity().runOnUiThread(() -> call.resolve(
                        out.put("state", "failed").put("error", e.getMessage() == null ? "unknown" : e.getMessage())));
            }
        });
    }

    @PluginMethod
    public void analyzePosition(PluginCall call) {
        String fen = call.getString("fen");
        if (fen == null || fen.trim().isEmpty()) { call.reject("missing fen"); return; }
        Integer depth = call.getInt("depth");
        Integer movetime = call.getInt("movetime");

        executor.execute(() -> {
            try {
                ensureStarted();
                int d = depth == null ? 0 : depth;
                String go = d > 0 ? "go depth " + d
                        : "go movetime " + (movetime == null || movetime <= 0 ? 300 : movetime);
                SearchResult r = runSearch("position fen " + fen, go);
                int guard = 0;
                while (broken(r) && guard < 3) {
                    guard++;
                    Thread.sleep(700);
                    r = runSearch("position fen " + fen, go);
                }
                if (broken(r)) throw new IllegalStateException("analysis produced no real search");
                JSObject res = toJson(r);
                bridge.getActivity().runOnUiThread(() -> call.resolve(res));
            } catch (Exception e) {
                bridge.getActivity().runOnUiThread(() -> call.reject(e.getMessage() == null ? "engine error" : e.getMessage()));
            }
        });
    }

    private JSObject toJson(SearchResult r) throws Exception {
        JSObject out = new JSObject();
        out.put("best", r.best);
        out.put("ponder", r.ponder);

        // deepest line per multipv
        Map<Integer, Info> best = new HashMap<>();
        for (Info i : r.infos) {
            if (i.pv.isEmpty()) continue;
            Info cur = best.get(i.multipv);
            if (cur == null || i.depth > cur.depth) best.put(i.multipv, i);
        }
        JSArray arr = new JSArray();
        best.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> {
            Info i = e.getValue();
            JSObject o = new JSObject();
            try {
                o.put("multipv", e.getKey());
                o.put("depth", i.depth);
                o.put("nodes", i.nodes);
                o.put("time", i.timeMs);
                if (i.scoreCp != null) o.put("scoreCp", i.scoreCp);
                else if (i.scoreMate != null) o.put("scoreMate", i.scoreMate);
                o.put("pv", new JSArray(i.pv));
                arr.put(o);
            } catch (Exception ignored) { }
        });
        out.put("lines", arr);
        return out;
    }
}
