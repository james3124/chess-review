# Stockfish (bundled engine)

This directory holds the **corresponding source code** for the Stockfish
binary that ships inside this app's APK, as GPL-3.0 requires.

| | |
|---|---|
| **Project** | Stockfish — https://github.com/official-stockfish/Stockfish |
| **Version shipped** | Stockfish 19, the `sf_19` release asset `stockfish-android-arm64-universal.tar.gz` |
| **Licence** | GNU General Public License v3.0 — see `Copying.txt` |
| **Authors** | see `AUTHORS` |
| **Build instructions** | see `README.upstream.md` (Stockfish's own README) |

## Why we ship the binary instead of rebuilding it

The `arm64-universal` package is not a generic build. It contains **both** the
`armv8` and `armv8-dotprod` code paths and selects between them at startup:

```c
static int dispatch(const CpuFeatures& f, int argc, char* argv[]) {
    if (!f.dotprod) return entry_armv8(argc, argv);
    return entry_armv8_dotprod(argc, argv);
}
```

...where `f.dotprod` comes from `getauxval(AT_HWCAP) & HWCAP_ASIMDDP`
(see `src/universal/entry_arm64.cpp`). So on a CPU that supports dot-product
instructions this binary is already running the faster code path, and
rebuilding it locally would at best reproduce the same thing.

The actual cost of the engine is loading its **109 MiB embedded NNUE network**
(via `src/universal/nnue_embed.cpp`), which no compile-time choice changes.

## If you do want to rebuild it

Extract the release tarball, then build with Stockfish's Makefile; the
relevant Android arch is `armv8-dotprod` (or `armv8` if the target device lacks
`asimddp`). See `README.upstream.md`.
