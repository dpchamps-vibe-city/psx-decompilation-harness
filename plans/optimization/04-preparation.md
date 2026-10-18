# Phase 4 — Preparation

Status: proposed. Depends on: Phase 0 and decision D1.

## Goal

Preparation should produce the handoff the agent needs, and nothing it never
reads, in about a second. A re-preparation with nothing changed should cost
only a freshness check.

Target: 5.0 s → ≤ 1.5 s warm with D1-A, or ≤ 3 s with D1-B. A no-op
re-preparation should cost ≤ 0.3 s.

## Where the time goes today

`prepareAttempt` (`.pi/extensions/psx-decomp/tools/prepared-attempt.ts:16`)
spawns `m2cFunc.ts`. That process loads 93 modules, including the unused exe
route, and then runs `prepareLibraryFunction`
(`tools/agent/libraryTarget.ts:386`).

| Step | Time | Notes |
|---|---|---|
| process start, inventory parse, spimdisasm | 0.42–0.49 s | |
| input and tool hashing | ~125 ms | the local `hashFile` bypasses the content memo; `prepareM2c` hashes ~1,300 m2c files twice |
| context cpp and owner-scope preprocess | ~60 ms | |
| m2c | 90–100 ms | |
| compile and compare | 20–30 ms | 26 of ~40 recent drafts fail in cc1 |
| `scanReadBeforeDef.ts` (separate process, serial) | 0.69–0.80 s | mostly startup plus `nestedFunctionCensus` re-parsing the inventory |
| `triage.ts` (separate process, serial) | 3.4–3.8 s | breakdown below |

Triage breakdown:
- macro identity: inventory re-parse plus 2 uncached probe compiles;
- `nestedFunctionCensus` again;
- 3–4 recompiles of the draft. Its compile caches are keyed by path, and every
  draft path is new, so they always miss;
- the idiom corpus load (`tools/agent/idiom-corpus/corpus.ts:371`), 2.0–2.3 s.
  It re-validates all 2,224 accepted records and reads ~850 region caches
  (13.4 MB).

The two diagnostics run one after the other (`libraryTarget.ts:519-530`). From
triage, the library route keeps `macroIdentity` and `findings`, but `findings`
is only stored in `packet.discovery.report`. The handoff renders
`macroIdentity`, and the agent is told `packet.json` is not a reading task. So
the corpus result reaches the agent nowhere.

Every call writes a new timestamped run directory. Unlike the exe route, there
is no fingerprint reuse.

## Decision D1 (required before 4.2)

- **D1-A (recommended).** Library preparation computes `macroIdentity` inline,
  cached by member content and toolchain identity. Full triage, idiom
  precedents included, runs on demand through its existing tool, or in the
  background after the handoff. Exact packets skip it.

  This changes `packet.json` content (no inline triage findings), not the
  handoff text. The packet records where to get triage on demand.
- **D1-B.** Triage stays inline. The idiom corpus becomes one persistent
  aggregate keyed by (implementation identity, verified set plus workspace
  snapshot), updated incrementally by one region per completion, with the
  current per-member verification semantics kept.

## Work items

### 4.1 Single hashing pass and lazy imports

- Route `libraryTarget.ts`'s local `hashFile` through `contentCache.fileDigest`
  inside the script host's memo scope.
- Call `prepareM2c` once.
- For library projects, import the exe route in `m2cFunc` / `prepareFunction`
  lazily.

### 4.2 Triage per D1

Implement A or B. Under A, macro identity probes are cached by
`(probe source hash, flags, tool identities)`.

### 4.3 Overlap the remaining diagnostics

- `scanReadBeforeDef` needs only the target, so start it at t=0, concurrently
  with m2c and the compile.
- Under D1-B, run triage concurrently with the compile and pass it the
  preparation's compile output (`--prepared`), instead of recompiling.
- Both diagnostics move in-process in Phase 6. Until then they stay separate
  processes but run in parallel.

### 4.4 Library packet fingerprint reuse

`packet.identity.fingerprint` already digests inputs and memberships. Before
generating:

1. Look up an existing packet **by fingerprint and draft-text hash**. Never
   pick the newest directory by mtime.
2. If it exists and is fresh by `packetIsFresh`, return it.

A re-preparation after a prep turn that changed nothing then costs only the
check.

### 4.5 Parent-side freshness and staging

In the extension process:

- memoize `packetIsFresh` within one `attemptStaticFinalization` (it runs
  again inside `stagePrepared`);
- scope `preparationTools` to the target member instead of parsing the whole
  inventory;
- reuse the Phase 1 input snapshot instead of a fresh `buildInputs()`.

### 4.6 Verify re-preparation after prep turns

`latest-library.json` is written only after a successful compile
(`libraryTarget.ts:540`). Check what re-preparation measures after a prep turn
that leaves the draft non-compiling: the edited draft, or a regenerated m2c
draft? Fix it if edits can be lost. This is a correctness item, found during
tracing and not yet confirmed.

## Measurement and acceptance

Scenarios: the full manifest of packet outcome classes ([00](00-measurement.md)
§0.7), each cold, warm and after-N; the re-prep-after-prep-turn case, with the
draft both compiling and not compiling.

- Preparation p50 warm: ≤ 1.5 s (D1-A) or ≤ 3 s (D1-B). No-op re-prep
  ≤ 0.3 s.
- Counters per preparation: 1 inventory parse, 1 compile of the draft, and no
  corpus revalidation (D1-A) or an incremental update only (D1-B).
- **Equivalence**, normalized and byte-identical to the unoptimized path:
  - `primary.text`, raw m2c output and `m2c.ctx`;
  - `.i`/`.s`/`.o` hashes and `comparison.json`;
  - blockers, unknowns, `macroIdentity` and `readBeforeDefinition`;
  - identity inputs and fingerprint;
  - `handoff.md` and `evidence.md`.

  Under D1-A, on-demand triage findings must equal today's inline findings for
  the same draft. Under D1-B, the inline findings are compared directly.

## Negative controls

A reused packet must be rejected after:

- a header edit;
- a sibling part converted in the same directory TU;
- a new accepted record (D1-B corpus);
- an experiment-ledger append;
- a flag-override or toolchain change;
- a draft-text change.

## Risks

- **D1-A removes inline information some workflow relies on.** Search for
  readers of `packet.discovery.report` before landing. Today only the exe
  route in `prepareFunction.ts` reads it.
- **Instruction contracts.** If handoff or evidence text changes, update it
  through the instruction-contract snapshot workflow, with review.
