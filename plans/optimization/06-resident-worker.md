# Phase 6 — Resident harness worker

Status: proposed. Depends on: Phases 2 and 5, and decision D3.

## Goal

Pay process startup and the shared derivations once per session instead of
once per call, without giving up the statelessness guarantee. That covers
module loading, the inventory, tool identities and file hashes.

This speeds up all three bottlenecks and the in-turn tools.

Targets:
- `psx_residual_objective`: 0.70 s → ≤ 0.2 s mean;
- finalize: ≤ 0.5 s;
- selection: ≤ 0.2 s;
- preparation: the Phase 4 figures minus the spawn floor.

## Where the time goes today

- Each harness subprocess pays ~0.13 s for node and tsx, plus ~0.07–0.15 s to
  import 70–150 modules. That includes tree-sitter's top-level WASM init, which
  also hashes the wasm twice.
- Most then parse the 2,167-object inventory again (~0.2 s).
- With the pre-Phase-5 counts, one function used ~10 such processes in the
  windows plus one per in-turn tool call. Every in-memory memo
  (`contentMemo`, `invocationMemo`, `withLibraryMetadata`, `searchMemo`) dies
  with the process.

## Work items

### 6.1 Worker process and protocol

The extension starts one long-lived child process: node with tsx loaded once,
running `scriptHost`. It speaks a small request/response protocol over IPC.

Requests cover what currently spawns a script:
- graph rebuild;
- preparation;
- the unified gate (Phase 5);
- function diff;
- residual objective;
- the other `psx_*` tools that run harness scripts.

Responses carry the same results the CLIs produce today.

### 6.2 What it may hold

Everything it holds is keyed by fingerprint and re-validated on use:
- the loaded module graph;
- the library inventory, keyed by the input-object fingerprint;
- tool identities, keyed by binary stat and hash;
- the file-hash memo, with the ctime guard;
- census, macro-probe and corpus caches.

### 6.3 Statelessness compliance

The rules of `tools/agent/statelessness.test.ts` apply to each request:

- every input a request relies on is fingerprinted at request time, which is
  cheap with the stat memo;
- no request assumes an earlier request ran;
- no artifact is chosen by mtime;
- cached artifacts carry provenance.

Add a test that runs every request type twice with an input changed in between
(header, source, record, toolchain), and checks the second result against a
fresh process.

### 6.4 Code identity

At startup the worker records the hash of its loaded harness module closure,
from the Phase 2 closure computation. Before each request batch, the extension
compares that with the on-disk closure. On a mismatch, it restarts the worker
before serving. A worker never serves results from old code.

### 6.5 Cancellation, health and fallback

- **Abort** kills the worker's process group, as `runCommand` does today, and
  the worker restarts lazily. Outputs it writes must be atomic: convert the
  non-atomic disassembly writes in `disassembleLibraryMember`
  (`libraryTarget.ts:216-226`) to write-temp-then-rename.
- **Health:** restart after a request count or an RSS limit, and on any
  protocol error.
- **Fallback:** the per-call spawn path remains, selectable by an environment
  toggle. The equivalence oracle uses it, and so does any environment where
  the worker cannot start.

## Measurement and acceptance

Scenarios: the Phase 0 replay (hot worker vs cold processes); in-turn tool
microbenchmarks; harness edit mid-session; abort mid-request.

- Targets as in the goal. Counters: 0 process spawns per window on a hot
  worker, apart from the compiler toolchain and git.
- **Equivalence:** every output from the worker is identical to the spawn path
  across the replay, the Phase 1 negative controls and the 6.3 change-between
  test.
- A harness edit restarts the worker before the next request, and results match
  a fresh process.
- An abort mid-request leaves no partial output, and the next request succeeds.

## Risks

- **Stale state.** Mitigated by fingerprint re-validation on every request
  (6.3) and code identity (6.4). If a stale result is ever observed, that is a
  bug to fix, not a tolerated trade-off.
- **Memory growth** across long sessions. Mitigated by caches bounded by key
  count and by periodic restarts.
- **Synchronous work blocking the worker.** There is one worker per session.
  Background speculation (Phase 7) may need a second one at lower priority.
