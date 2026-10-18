# Baseline evidence (pre-optimization)

Status: reconstructed evidence, gathered 2026-10-17. It is not a substitute for
the Phase 0 bench. Phase 0 re-records these numbers under a controlled protocol
(idle machine, at least 5 runs, median and p90).

## Sources and method

- **Reference consumer.** The relocatable-library project at
  `../psyq-decomp`, which runs on this installed harness. The exe prototype
  this harness grew out of is excluded on purpose: it uses its own vendored,
  make-based tooling and does not reflect this harness's code paths.
- **Autoloop session.** Session log
  `~/.pi/agent/sessions/--home-dave-Documents-code-psyq-decomp--/2026-10-17T20-04-30-102Z_*.jsonl`.
  It covers 15 consecutive libc2 matches, from `putchar` (`1836af3a`) through
  `strncmp` (`dc9135d2`): 13 finalized by the agent and 2 static. Message
  timestamps give the boundaries:
  - the agent's `psx_finalize_function` call and result;
  - the documentation prompt;
  - the documentation turn's last reply;
  - the next opening message.

  Each `psx_finalize_function` result carries `details.timings` and
  `details.finalizationGates[].timings`.
- **Preparation.** Spawn times come from directory names under
  `build/preparation/commands/<key>/<ms>-<pid>/`, and end times from the
  `prepare.stdout` mtime. Library packets record no phase timings
  (`packet.performance` is set only on the exe route), so phase splits inside
  preparation were rebuilt from artifact mtimes across ~60 runs.
- **Commits.** `git log` commit times are whole seconds, so the columns derived
  from them are ±1 s.
- **Code tracing.** Call trees and counts come from a read-only trace of the
  harness. Values marked "est" are inferences from code and partial timings.
- **Host.** Linux, 24 cores, Node v24.1.0, warm page cache. While some of these
  measurements were taken, the live autoloop was running on the same machine.
  Contention made runs 1.5–2× slower in every phase.

## Steady-state gap per matched function

| Segment | Time | Notes |
|---|---|---|
| Agent `psx_finalize_function` | 3.5 s | 9–20 s outliers, see below |
| Loop post-turn re-verification | 5.3 s | 5.2–6.6 s across 13 functions |
| Documentation turn (model) | 27 s mean | 16.7–46.7 s |
| Documentation end → commit | ~0.5 s | `buildInputs` + `writeState` + git |
| Commit → preparation spawn | ~2.8 s | of which graph rebuild ~2.5 s; graph write → prep spawn ≈ 33 ms |
| Preparation subprocess | 5.0–5.2 s | 7–8 s under contention |
| Preparation end → opening message | 0.2 s | |
| **Harness compute total** | **~17.5 s** | 17.2–17.7 s on clean runs |

Over the whole cycle (13 functions, mean 206 s):

| Part | Mean | Share |
|---|---|---|
| Model solve | 155 s | 75% |
| Documentation turn | 27 s | 13% |
| Harness compute | 24 s | 12%, including static-match and outlier functions |

## Agent finalize phases (library branch)

| Phase | Typical |
|---|---|
| library-inputs (`libraryWorkspaceIdentity`) | 310 ms |
| policy | 2 ms |
| function-diff (spawns `diffFunc.ts`) | 480 ms |
| relocatable-members (spawns `library.ts check --member`) | 1.1 s |
| context-export (spawns `contextExport.ts`) | 1.0 s |
| library-inputs (again) | 160 ms |
| **Total** | **~3.3 s** |

### Outliers

| Run | relocatable-members | finalize total |
|---|---|---|
| qsort | 7.7 s | 9.9 s |
| index | 6.7 s | 8.9 s |
| rindex | 16.3 s | 20.1 s |

In every outlier, the member check recompiled all ~760–789 accepted members.
The cause is `libraryVerificationKey` (`tools/agent/libraryTarget.ts:367`).
It hashes every non-test file under the harness `tools/` tree, plus
`tools/vendor/tree-sitter-c`, `.pi/extensions/shared` and `package-lock.json`.
The outlier times line up with local harness edits, including edits under
`tools/testing/`.

## Finalization window counts per match (traced, est)

- 7 tsx process spawns:
  - the agent gate: diff, check, export;
  - the loop's re-check: diff, then diff, check and export again;
  - the selection rebuild is extra.
- 9 full parses of the 2,167-object inventory.
- The same TU compiled 6 times.
- About 40 git commands. `loopChangedFiles` runs 4 times, plus the tool's own.
  Each temp-index tree build spends about 85 ms, and that is mostly spawn
  overhead: hashing all 7,211 files in the allowed roots takes 34–40 ms.
- 3 `buildInputs()` calls at 200–250 ms each (9,434 entries; measured
  in-process). The loop has no content-memo scope, so each call re-reads and
  re-hashes everything.
- 1–2 `writeState()` calls. `run_output/autoloop/state.json` is 100.65 MB,
  pretty-printed and growing by about 1.1 MB per completion (`inputs` maps).

## Selection (`nextTarget` → `rebuildCallGraph`)

- Spawn floor: node+tsx is 0.13 s. Importing the 69 modules adds 0.075 s, and
  that includes exe-only modules and tree-sitter's top-level WASM init.
- `writeLibraryGraph` components:

| Component | Time |
|---|---|
| `libraryMembers` (reads, hashes twice and parses 2,167 `.o` files) | 190 ms |
| object and header snapshot | 89 ms |
| `src/` walk and hash (7,139 files) | 87 ms |
| `compilationIdentity` | 38 ms |
| `libraryTuStatus` over 3,430 parts | 327 ms (repeated twice more) |
| include-membership walks (no `withPreprocessorMetadata` scope) | 162 ms |
| per-member `toolConfiguration` | ~90 ms |
| per-function `libraryFunctionTarget` (reloads `project.json` and `toolchain.json`) | 108 ms |

  These account for 1.8–2.2 s of the ~2.5 s.
- `nextTarget` consumes only array order plus `name`, `decompiled`,
  `handwritten` and `dead`. For the library graph, the order is fixed inventory
  order and never re-ranked.
- On failure, `oracles.ts:178` silently falls back to the stale graph.

## Preparation (library route)

| Step | Time |
|---|---|
| m2cFunc process startup, inventory, disassembly | 0.42–0.49 s |
| input and tool hashing (non-memoized local `hashFile`; `prepareM2c` twice) | ~125 ms |
| context cpp + owner-scope preprocess | ~60 ms |
| m2c (python3) | 90–100 ms |
| compile + compare | 20–30 ms |
| `scanReadBeforeDef.ts` subprocess (serial) | 0.69–0.80 s |
| `triage.ts` subprocess (serial) | 3.4–3.8 s |
| — of which idiom corpus load (`corpus.ts:371`) | 2.0–2.3 s |
| packet write | ~35 ms |
| parent `packetIsFresh` / `stagePrepared` (exact packets only, est) | 0.5–1 s |

Notes:
- Triage's findings are stored only in `packet.discovery.report`
  (`libraryTarget.ts:528`). The handoff renders `macroIdentity` and nothing
  else from triage.
- The inventory is parsed at least 5 times per preparation.

## In-turn tool time (same session, 45 minutes)

Tools took 280 s of the 2,701 s session (~10%).

| Tool | Calls | Mean |
|---|---|---|
| `psx_residual_objective` | 118 | 0.70 s |
| `psx_finalize_function` | 17 | 4.76 s |
| `psx_idiom_search` | 4 | 4.11 s |
| `psx_explain_diff` | 18 | 0.54 s |
