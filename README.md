# Chess Review

A mobile chess analyser. Load a `.pgn` and every move gets a
**chess.com-style label** — Brilliant, Best, Excellent, Good, Book,
Inaccuracy, Mistake, Miss, Blunder — driven by a bundled **Stockfish 19**
engine.

Runs as an **installable PWA** in the browser, or as an **Android APK** built
by GitHub Actions.

```
PGN ─► chess.js (moves/legality) ─► Stockfish (UCI, per-position eval)
      ─► win-probability math ─► labels ─► report
```

## No ML model needed

Stockfish's NNUE network is **compiled into the binary** (~109 MiB, which is
why the file is so large) — there is no `.nnue` file to download. The labels
themselves are arithmetic, not inference: the engine score is converted to win
probability, the loss is thresholded, and Brilliant additionally checks for a
material sacrifice. Exactly how chess.com does it.

## Layout

```
stockfish/stockfish-android-arm64-universal   engine (not committed; CI fetches it)
server.mjs                                    dev server (browser / CLI use)
lib/engine.mjs                                 UCI bridge (Node)
lib/store.mjs                                  saved analyses
www/                                          the app UI
  index.html  app.js  board.js  native-bridge.js  styles.css
  lib/classify.js   lib/pgn.mjs   lib/analyze.mjs   shared by server AND WebView
  vendor/chess.js                                  vendored by scripts/build-web.mjs
android/                                        Capacitor Android project
  .../EnginePlugin.kt                             UCI bridge for the APK
.github/workflows/build-apk.yml                   builds the APK on push
test/sample.pgn · test/run-sample.mjs             end-to-end test
```

## Use it in a browser (no build needed)

```bash
npm install
npm run build:web      # vendor chess.js into www/
npm start              # http://localhost:3000
```

Open `http://localhost:3000`, press **PGN** or **Paste**, pick a depth, and the
moves stream in as Stockfish finishes them.

The app does not care where its own files are served from — it looks for the
analysis server on the current origin first, then `localhost:3000`, then
`127.0.0.1:3000`, then `:8080`. So opening `index.html` from an editor's live
preview (any port) works fine as long as `npm start` is running. Tap the engine
bar to pin the server address manually.

## Test the analysis pipeline directly

```bash
node test/run-sample.mjs        # analyses test/sample.pgn at depth 12
DEPTH=16 node test/run-sample.mjs
```

## Build the APK (GitHub Actions — the normal path)

Push to `main`. The workflow:

1. checks out the repo, installs Node deps, vendors `chess.js`
2. downloads the official `stockfish-android-arm64-universal` release build
   (override with a `STOCKFISH_URL` repository variable to pin a version)
3. runs `npx cap add android` (if needed) + `cap sync android`
4. drops the binary into `jniLibs/arm64-v8a/libstockfishengine.so`
5. `./gradlew assembleDebug`
6. uploads `app-debug.apk`, and publishes a `latest` release on `main`

Download the APK from the workflow run or the Releases page.

## How the engine is run in the app

Android refuses to execute a file inside a compressed APK, so the binary ships
as `jniLibs/arm64-v8a/libstockfishengine.so` with `extractNativeLibs="true"`.
Android unpacks it into `applicationInfo.nativeLibraryDir`, and
`EnginePlugin.kt` runs it with `ProcessBuilder`, speaking UCI.

**Gotcha worth knowing:** the arm64 *universal* build loads its NNUE net
lazily — the load is triggered by the **first `go`**, and `isready` does
**not** wait for it. A search issued during the load returns a fake result
(`nodes 0`, empty `pv`, bogus `bestmove a2a3`) instead of failing. Both
bridges therefore validate every search (nodes > 5 **and** a non-empty PV) and
retry until the engine is genuinely searching. Without this the app would
silently annotate a whole game with garbage.

## Performance notes (measured here: Unisoc T606, 6×A55 + 2×A75 @ 1.6GHz)

- **One thread is fastest — and deterministic.** At fixed depth 14, an
  11-move game took **17.9 s with 1 thread**, 18.6 s with 2, 21.2 s with 4.
  Stockfish's Lazy SMP waits for the *slowest* helper thread each iteration,
  and with only 2 fast cores among 8 the extra threads land on little cores
  and straggle. More threads explore more nodes per second, but at **fixed
  depth** the search stops at the same depth, so those extra nodes are just
  extra work — `nodes/sec` is the wrong metric for this app.
- With >1 thread Stockfish is also **non-deterministic** (Lazy SMP results
  depend on timing), so re-analysing a game can yield different labels.
- Threads would only help with `go movetime`, where "deeper in fixed time" is
  the goal — which is not how this app searches.
- **Startup** is dominated by loading the 109 MiB embedded NNUE network
  (~1 s here; longer in the APK, where Chromium competes for RAM). Threads do
  not affect it — hence the lazy load on the first game.
- The bundled engine already uses `dotprod`: the `arm64-universal` package
  contains both the `armv8` and `armv8-dotprod` builds and picks one at
  startup, so rebuilding from source would not speed it up.
- ~0.6 s per position at depth 12, ~1.6 s at depth 14. A 33-move game is
  ~55 s at depth 14 on this CPU, so expect a few minutes on a phone.

## Licence

Stockfish is **GPL-3.0**. Bundling it makes this app GPL-3.0 too, which in
practice means: don't distribute a closed-source build, and the corresponding
source must be available. **This repo satisfies that** —
`third_party/stockfish/` holds the source for the exact binary the APK ships
(`sf_19`'s `stockfish-android-arm64-universal`). CI still downloads the
official release asset rather than rebuilding, because that binary is already
the optimal build for this device; see `third_party/stockfish/README.md`.
