# Phase 7 — Overlap harness work with model time

Status: proposed. Depends on: Phases 3 and 4 (6 recommended), and decision D2.

## Goal

Do the next function's selection and preparation while the model is still
solving the current one; the model averages ~155 s per function. That leaves
only commit and a freshness check on the critical path. Decide whether the
documentation turn should block the next function (D2).

Target: from the agent's passing finalize result to the next opening message,
≤ 2 s p50 on the replay. Prefetch hit rate ≥ 80% on the library replay. No
change in matched or parked outcomes.

## Work items

### 7.1 Speculative selection and preparation

After function N's handoff, a background task:

1. Takes N+1 from the Phase 3.5 precomputed next target.
2. Runs Phase 4 preparation for it into `build/preparation/` at lower CPU
   priority, through a second worker or a niced process.
3. Optionally continues to N+2.

Constraints:
- **Never prefetch in N's member.** Same-TU parts share owner-scope context,
  disassembly outputs and the stub verdict.
- **At most one preparation per member at a time.**
- **Speculation never stages into `src/` and never commits.** Its only output is
  a packet plus its fingerprint.

### 7.2 Validate at use

When N+1's turn comes, accept the prefetched packet only if all of these hold:

- `packetIsFresh` passes;
- a digest of the inputs that shape the packet but aren't yet in its identity
  is unchanged:
  - the verified set and corpus (D1-B only);
  - `notes/file-groupings.md` (cluster donor);
  - the experiment ledger;
- N+1 is still the selected target, after `skip` and `defer` changes from a
  park.

Otherwise re-prepare synchronously and count the miss. A prefetched exact packet
goes through the ordinary static finalization in sequence, so commit scope stays
per function.

### 7.3 Documentation placement (D2)

- **D2-A (status quo):** the documentation turn blocks.
- **D2-B (recommended):** after a verified match, the completion is recorded
  with documentation `pending`, the match is committed, and the loop moves on.
  Pending documentation runs in batches, every K functions or at loop end,
  each committed as its own notes-only commit.

  The loop already resumes pending documentation. Today it takes pending items
  ahead of the next target (`runLoop`), so the order needs changing.

  Trade-off: a later function's preparation and file-groupings lookup can run
  before the latest groupings are written. Include
  `notes/file-groupings.md` in the 7.2 digest so the staleness is visible, not
  silent.
- **D2-C:** run documentation concurrently in a second Pi session. This is
  more complex: two sessions share the working tree and need separate
  notes-only write scopes.

### 7.4 Contention control

Speculation must not slow the foreground. Concurrency is bounded, priority is
lowered, and speculation pauses while a foreground gate or compile runs. The
bench measures foreground tool latency with and without speculation.

## Measurement and acceptance

Scenarios: replay-N with prefetch on and off; header-edit mid-solve; park
inside the replay (which changes `defer`); same-member consecutive targets.

- Finalize result → next opening message: ≤ 2 s p50.
- Prefetch hit rate ≥ 80% on the library replay. Every miss is logged with its
  reason.
- Foreground tool latency with speculation stays within 10% of without.
- **Equivalence:** the replay's sequence of targets, verdicts, commits and
  accepted records is identical with prefetch on and off. Speculation writes
  nothing outside `build/`.
- D2-B: every match still gets its documentation within the batch bound. The
  notes commits contain only `notes/`, and match commits contain no notes from
  other functions.

## Negative controls

- Function N edits a header mid-solve: the prefetched packet is rejected.
- A park adds N+1's family to `defer`: the prefetched packet is discarded and
  the right target is prepared.
- A target in the same member as N is never prefetched.
- Aborting the loop mid-prefetch leaves no partial packet that a later run
  could mistake for fresh. Packets are written atomically, and lookup is by
  fingerprint only.

## Risks

- **Wasted work on a miss.** It is bounded by one preparation per miss and runs
  off the critical path.
- **Hidden ordering dependencies.** Every input that shapes a packet must be in
  its identity or the 7.2 digest. Phase 0's equivalence oracle on prefetch
  on/off is the guard.
