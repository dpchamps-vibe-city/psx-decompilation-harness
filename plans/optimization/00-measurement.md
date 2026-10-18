# Phase 0 — Measurement fixtures and baseline

Status: proposed. Depends on: D4 (bench location). Every other phase depends
on this one.

## Goal

Make the three bottlenecks measurable, reproducible and guarded:

- production runs record their own window timings;
- portable tests enforce counter budgets;
- an opt-in real-project bench and a scripted loop replay produce comparable
  before/after numbers;
- an equivalence oracle proves that an optimization changed no output.

Today the window costs had to be reconstructed from session logs and file
modification times ([baseline.md](baseline.md)).

## Work items

### 0.1 Process counters

Add a small counter module in `tools/lib/`, next to `Timings` in
`contentCache.ts`. Count:

- **Process spawns:**
  - `runCommand` (`.pi/extensions/shared/process.ts`);
  - `recordedCommand` (`tools/lib/recordedCommand.ts`);
  - `runTool` and `spawnSync` wrappers;
  - git calls separately.
- **Full inventory parses:** `libraryMembers` calls.
- **Compiles:** member and source compiles, keyed by TU.
- **Hashing:** `fileDigest` calls and bytes hashed.
- **Bookkeeping:** `buildInputs()` calls and `writeState` bytes.

Counting is off unless `PSX_PERF_COUNTERS=<file>` is set. When it is set,
every process appends one JSONL record on exit, so totals aggregate across
child processes. When it is unset, the cost must be negligible.

### 0.2 Window timings in production

Extend `Timings` through the loop and emit one record per function to
`<runtimeDir>/timings.jsonl`. Phases:

- post-turn checks: forbidden constructs, `isMatched`, `finalize`,
  `buildInputs`, `writeState`;
- documentation bookkeeping;
- commit;
- `clearContext`;
- selection;
- the preparation spawn;
- static finalization;
- the opening message sent.

Also fill the library route's `packet.performance` with phase timings, as the
exe route already does. From then on, every production run is a measurement.

### 0.3 Portable synthetic library fixture

Promote the inline fixture in `tools/agent/libraryCheck.test.ts` to
`tools/testing/libraryProjectFixture.ts`. It should generate:

- N members (configurable, default about 64, enough to show scaling);
- a mix of accepted, backlog and directory-TU members;
- a shared owned header;
- a verified record set.

It has the same toolchain prerequisites as `libraryCheck.test.ts`. No consumer
data.

### 0.4 Counter budgets in `npm test`

On the synthetic fixture, assert counter budgets for each window:

- the finalize tool call;
- the loop post-turn window;
- selection;
- preparation.

Phase 0 records today's counts as the initial budgets, which documents the
waste. Each later phase tightens its budget in the same change. A budget
failure message names the counter and the window.

### 0.5 Equivalence oracle

`tools/testing/perfEquivalence.ts` normalizes and compares:

- **Gate results:** verdicts, failure kinds, diff summary; durations and
  timestamps stripped.
- **Accepted records**, byte for byte.
- **Preparation packets and companions:** timestamps, pids, run-directory
  paths, uuids and durations are normalized. Compare:
  - `primary.text`, raw m2c output and `m2c.ctx`;
  - `.i`/`.s`/`.o` hashes and `comparison.json`;
  - blockers, unknowns, `macroIdentity` and `readBeforeDefinition`;
  - the sorted triage findings;
  - identity inputs, memberships and fingerprint;
  - `handoff.md` and `evidence.md`.
- **Call-graph projection:** a hash of the ordered
  `(name, decompiled, handwritten, dead)` list, plus every field another
  consumer reads (`vram`, `container`, `source`, `calls`).
- **Selected targets**, under randomized `skip` and `defer` sets.

Each phase runs it A/B: the unoptimized path (a toggle, or the previous
installed package) against the optimized one, on identical inputs.

### 0.6 Scripted loop replay

`tools/testing/loopReplay.ts` drives `runLoop` with the real oracles and a fake
Pi context, following the fakes in
`.pi/extensions/psx-decomp/autoloop/loop.test.ts`. The scripted agent:

1. reads the replay manifest entry for the selected target: target key →
   matching source text;
2. writes that source;
3. calls the finalize tool through the same route the agent uses;
4. ends its turn.

The documentation turn appends a fixed note under `notes/`. With no model
variance, the replay measures the harness's own gap per function: from the
finalize result to the next opening message. It runs on the synthetic fixture
(portable, small) and on the real-project bench (opt-in).

### 0.7 Opt-in real-project bench

`tools/testing/loopBenchmark.ts` follows the guard pattern of
`tools/testing/installedRuntimeTimings.ts`:

- It refuses any workspace that is not disposable. Disposable means an
  explicitly named directory with a marker file the bench created.
- It builds the workspace with `git clone --no-hardlinks` of the consumer at a
  pinned commit, then copies the required inputs:
  - `library-input/`;
  - `build/dependencies`, and optionally `build/cache/dependencies`;
  - `build/libraries/verified`;
  - `project.json`, `toolchain.json` and `.pi/autoloop.json`.

  It never copies `build/libraries/candidates` (1.4 GB of leftover compile
  directories).
- Targets and replay commits come from a manifest file supplied with the run,
  never from harness code.
- It records median and p90 over at least 5 runs, under cold, warm and
  hot-worker regimes. It checks that the machine is idle before starting:
  contention doubled phase times in the baseline.

Scenarios (each later phase picks its subset):

| Scenario | State |
|---|---|
| cold | empty `build/cache`, `idiomCorpus`, `pipelineReversal`, `triage` and the tsx cache; fresh process |
| warm no-op | immediately repeated operation |
| after-N | apply match commit N and its accepted record |
| header touch | owned header edited, affecting K members |
| toolchain change | `toolchain.json` or `configs/flag_overrides.mk` edited |
| revert part | one TU part reverted to `INCLUDE_ASM` |
| harness edit | edit a harness file outside, then inside, the verification closure |
| replay-N | N consecutive match commits through the loop replay |

Initial manifest for the reference consumer. It lives with the bench run, not
in harness code.

- **Preparation classes, one per packet outcome:**

| Class | Target |
|---|---|
| platform macro | `lib_1541083c1d7b8934_0::realloc` |
| m2c draft fails to compile | `lib_e1828ca43cda138a_0::strncpy` |
| compiles but mismatches | `lib_25f493c082078483_0::bsearch` |
| exact static | `lib_caa9d705cf395a2f_0::srand` |
| existing C | `lib_55fbf6eed978186c_0::malloc3` |
| same-member pair | `lib_07b11d80dde84c53_0::qsort` → `func_000001B8` |
| large PAD member | `lib_a8f7345a144556eb_0` |

  Each entry records the consumer commit it is prepared at: the parent of the
  target's own `match` commit. Without that, the outcome class can't be
  reproduced. For example, the live loop matched `strncpy` at `5313a9a4`.
- **Replay:** the 15 consecutive libc2 matches from `putchar` (`1836af3a`)
  through `strncmp` (`dc9135d2`): 13 finalized by the agent and 2 static
  (`func_000001B8`, `srand`). Start from `putchar`'s parent commit.

### 0.8 Record the baseline

Run every scenario under the protocol and record a timings-only table in
`plans/optimization/baseline-measured.md`. Use the format of
`plans/installed-package-runtime-timings.md`: all repetitions shown, plus the
noise rule. That table is the reference for every later acceptance check.

## Acceptance

- Production runs emit `timings.jsonl`, and library packets carry
  `performance`.
- Counter budgets run in `npm test` on the synthetic fixture, and budget
  failures are actionable.
- The replay reproduces the reconstructed steady-state breakdown within ±15%
  for each segment on the real-project bench.
- The equivalence oracle passes the current code against itself, which proves
  that normalization is complete.
- The measured baseline is recorded.

## Must not change

Production behavior. Phase 0 adds observation only. Counters and timings must
not change verdicts, outputs or any agent-facing text.

## Risks

- **Normalization hiding a real difference.** Keep an explicit allowlist of
  normalized fields, and test that a deliberately changed packet field fails
  the oracle.
- **Disk.** The bench copies about 1 GB. Check free space before creating a
  workspace, and delete it afterwards.
