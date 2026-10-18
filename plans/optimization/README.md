# Autoloop critical-path optimization

Status: proposed plan. This document alone authorizes no implementation
change. Each phase lands separately, with its own measurements, and needs the
decisions marked below before work starts.

## Problem

Between one solved function and the start of the next one, the autoloop runs
three serial compute phases: **finalization**, **next-candidate selection** and
**preparation**. While they run, no model is working. On the reference library
consumer, these phases add about 17.5 s of harness compute to every matched
function. A documentation model turn adds another ~27 s, and it blocks the
next function too. See [baseline.md](baseline.md) for the measurements and how
they were taken.

Most of the 17.5 s is repeated or unused work, not necessary work. Per matched
function:

- The finalization window starts 7 tsx processes and parses all 2,167 library
  objects 9 times. It compiles the same TU 6 times and runs about 40 git
  commands.
- The loop then re-runs the agent's entire passing finalization on unchanged
  inputs (~5.3 s).
- Selection rebuilds the whole 3 MB call graph in a fresh process (~2.5 s).
  `nextTarget` then reads four fields and the array order from it.
- Preparation spends ~3.5 of its ~5 s in triage. On the library route, the
  agent never sees triage's output apart from `macroIdentity`.
- Every in-memory cache dies when its subprocess exits.
- Every harness edit invalidates every accepted record. The next finalize then
  recompiles ~790 members, which produced the 7–20 s outliers.

## Goal

The aim is a near-zero harness critical path between solutions, without
changing any verdict. Concretely, from the agent's passing finalize result to
the next function's opening message: under 2 s at p50, measured on the replay
fixture. The baseline is ~14 s for that span (17.5 s including the agent's own
finalize). Keeping the documentation turn off that path is a separate decision
([D2](#decisions-required)).

## Principles (apply to every phase)

1. **Verdict equivalence.** For identical inputs, every optimized path must
   produce identical:
   - gate verdicts and failure kinds;
   - accepted records;
   - normalized packets;
   - selected targets;
   - verification receipts.

   Byte checks, scope gates and the clean-source policy are never weakened or
   skipped, including on cache hits.
2. **Reuse only on fingerprinted identity.** Follow
   `tools/agent/statelessness.test.ts`:
   - never select an input by modification time;
   - stat data may only short-circuit re-hashing, and only with a ctime guard
     against coarse timestamps;
   - every cached artifact records its provenance.
3. **Fail closed.** A cache or receipt miss, mismatch or error falls back to
   the full computation and is reported. A stale result is never used silently.
4. **Game agnosticity.** No consumer function names or paths go into harness
   code. Portable tests use synthetic fixtures. Real-project benchmarks are
   opt-in, run against disposable copies, and take their targets from a
   manifest supplied with the run (`docs/game-agnosticity.md`).
5. **Measured, budgeted landings.** Every phase lands with:
   - Phase 0 measurements before and after the change;
   - counter budgets that fail `npm test` if the waste comes back.

   A byte score or a single lucky run is not evidence.
6. **No scope creep.** Phases change performance plumbing only. Agent-facing
   text changes go through the instruction-contract snapshot workflow
   (`npm run test:update-instructions`) and need explicit review.

## Phases

| Phase | File | Removes | Est. saving per function | Depends on |
|---|---|---|---|---|
| 0 | [00-measurement.md](00-measurement.md) | Guesswork: counters, window timings, fixtures, replay, baseline | — | — |
| 1 | [01-finalization-window.md](01-finalization-window.md) | Loop re-finalization; duplicate `buildInputs`/git work; the 100 MB `state.json` | ~4.3 s | 0 |
| 2 | [02-verification-key.md](02-verification-key.md) | Mass re-verification on every harness edit; batch-discarding record writes | 7–20 s outliers | 0 |
| 3 | [03-selection.md](03-selection.md) | Full graph rebuild on the critical path; repeated per-member work | ~2.6 s | 0 |
| 4 | [04-preparation.md](04-preparation.md) | Inline triage and corpus load; serial diagnostics; no-op re-preps | ~3–4 s | 0, D1 |
| 5 | [05-unified-gate.md](05-unified-gate.md) | Three gate processes and three compiles in the agent's finalize | ~2.5 s | 0, 1 |
| 6 | [06-resident-worker.md](06-resident-worker.md) | Process startup and per-process re-derivation everywhere, including in-turn tools | ~1.5–2 s, plus in-turn tool time | 2, 5, D3 |
| 7 | [07-pipelining.md](07-pipelining.md) | Serial selection and preparation; documentation on the critical path | remaining prep and selection, plus ~27 s with D2 | 3, 4, (6), D2 |

All savings are estimates from [baseline.md](baseline.md). Each phase must
re-measure them.

Phases 1–4 are independent of each other once Phase 0 lands, and can proceed in
parallel. Phase 5 hosts the gate in-process, which Phase 6 then keeps resident.
Phase 7 needs fast, fingerprint-checked preparation and selection before
speculation is safe.

### Estimated critical-path compute per function (steady state)

These are estimates, not measurements.

| After phase | Estimate | Main change |
|---|---|---|
| Baseline | 17.5 s | measured |
| 1 | ~13 s | loop recheck 5.3 s → ~1 s |
| 3 | ~10.5 s | selection 2.8 s → <0.3 s |
| 4 (D1-A) | ~7 s | preparation 5 s → ~1.5 s |
| 5 | ~4.5 s | agent finalize 3.5 s → ~1 s |
| 6 | ~2.5 s | spawn floor and inventory re-parses gone |
| 7 | ~1–1.5 s | next function prefetched; selection precomputed |

Phase 2 removes outliers rather than steady-state cost.

Today the mean cycle is 206 s. Compute alone is therefore worth ~8% more
throughput. Taking the documentation turn off the critical path (D2) brings the
total to ~26%. Phase 6 also cuts in-turn tool time. In one 45-minute session,
`psx_residual_objective` alone ran 118 times at 0.70 s each.

## Decisions required

- **D1, triage contract in library preparation** ([Phase 4](04-preparation.md)).
  - **A (recommended):** keep only the macro identity inline, cached, and run
    full triage on demand or after the handoff.
  - **B:** keep triage inline and make the idiom corpus incremental.

  Option A changes the content of `packet.json`. The handoff text renders only
  `macroIdentity`, so it is unaffected either way.
- **D2, documentation turn placement** ([Phase 7](07-pipelining.md)).
  - **A:** status quo, blocking.
  - **B (recommended):** defer and batch it.
  - **C:** run it concurrently in a second session.

  Under B, a later function's preparation can see `notes/file-groupings.md`
  without the latest groupings.
- **D3, resident worker** ([Phase 6](06-resident-worker.md)). Is a long-lived
  harness process acceptable under the statelessness policy, provided every
  request re-validates input fingerprints and code identity? Should it be a
  child process (recommended) or a worker thread?
- **D4, real-project bench location.** The opt-in bench needs a disposable copy
  of the reference consumer, about 1 GB once `build/libraries/candidates` is
  excluded. The disk is 98% full and `/tmp` is a small tmpfs, so the bench
  directory must be named explicitly.
- **D5, verification-key scope** ([Phase 2](02-verification-key.md)). Should
  "the harness that compiled, compared and audited the member" be narrowed to
  the verification path's module closure and runtime data?

## Progress

- [ ] D1–D5 decided
- [ ] Phase 0: measurement and baseline
- [ ] Phase 1: one verification per finalization window
- [ ] Phase 2: verification key and record writes
- [ ] Phase 3: selection
- [ ] Phase 4: preparation
- [ ] Phase 5: unified gate
- [ ] Phase 6: resident worker
- [ ] Phase 7: pipelining
