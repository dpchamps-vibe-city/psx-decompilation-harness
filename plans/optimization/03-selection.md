# Phase 3 — Next-candidate selection

Status: proposed. Depends on: Phase 0.

## Goal

Take selection off the critical path and make the remaining work proportional
to what changed.

Targets:
- commit → preparation spawn: 2.8 s → ≤ 0.3 s;
- a standalone graph rebuild: ~2.5 s → ≤ 1.0 s warm.

## Where the time goes today

`nextTarget` (`.pi/extensions/psx-decomp/autoloop/oracles.ts:173`) calls
`rebuildCallGraph` (`.pi/extensions/shared/call-graph.ts:96`). That spawns
`tools/agent/callGraph.ts`, which runs `writeLibraryGraph`
(`tools/agent/libraryTarget.ts:228`) and re-reads the 3 MB JSON it wrote.
`nextTarget` then uses only array order plus `name`, `decompiled`, `handwritten`
and `dead`. For the library graph, the order is fixed inventory order:

- sorted input path, then function order within the object;
- `dead` is always false and tier is always 1;
- the graph is never re-ranked.

Waste inside one rebuild ([baseline.md](baseline.md)):

- `libraryTuStatus` runs 3 times per member, and `libraryAssemblyTu` 3+ times.
- `project.json` is parsed ~6,400 times and the include directories walked
  ~8,000 times. Membership walks have no `withPreprocessorMetadata` scope.
- `libraryFunctionTarget` reloads `project.json` and `toolchain.json` twice per
  function.
- `libraryMembers` hashes the same bytes twice for standalone objects
  (`tools/lib/libraryTargets.ts:24,28`).
- `libraryMemberById` is a linear find, O(n²) overall.
- Every in-memory memo dies with the subprocess. Only `build/cache/dependencies`
  persists.

Between two consecutive selections, normally only the matched member's TU
parts, its accepted record and `notes/` change.

On failure, the rebuild silently falls back to the stale graph
(`oracles.ts:178`).

## Work items

### 3.1 Fail loudly instead of using a stale graph

When the rebuild fails, report the failure. Use the previous graph only if its
input fingerprint is unchanged; otherwise stop the loop with the error. This
is a correctness fix and lands first.

### 3.2 Start the rebuild as soon as finalize passes

Start `rebuildCallGraph` when the gate passes, before the documentation turn,
and await the promise in `nextTarget`. The graph doesn't depend on the
documentation turn, `writeState` or the commit:

- the matched source is already in place;
- documentation is proven notes-only by the `buildInputs` comparison;
- the commit doesn't change working-tree content.

Use the result only if the post-documentation input identity equals the
identity at rebuild start; otherwise rebuild synchronously. Never let the
background rebuild compete with the gate itself: start it after the gate
returns.

### 3.3 Memoize within one rebuild

- Wrap `writeLibraryGraph` in `withPreprocessorMetadata`.
- Compute `libraryTuStatus` / `readLibraryTu` and `libraryAssemblyTu` once per
  member.
- Pass `project` and the toolchain config through `libraryFunctionTarget`.
- Memoize per-member tool and flag lookups.
- Index members by id in a `Map`.
- Reuse `inputHash` for standalone objects in `libraryMembers`.

### 3.4 Persistent content-keyed per-member caches

Under `build/cache/`, add:

- object parse, private-function discovery, classification and edges, keyed by
  object sha256;
- TU status, keyed by the text hashes of its parts;
- per-member build identity, validated by stat and content the way
  `cppDependencies` already validates its records.

Keys include `sourcePolicy`, the SDK/owned headers, the tool identities and the
harness implementation identity (the Phase 2 closure). A rebuild after one
match then recomputes one member.

### 3.5 Precompute the next library target

For library projects, ordering doesn't depend on whether the current function
matches: the current function is already in `skip`, and the graph is never
re-ranked. When the current target is selected, also record the next eligible
candidate (respecting `defer`), along with the graph-input fingerprint
excluding the current member's files and records.

At the next selection, use it only if that fingerprint is unchanged and the
graph shows the candidate still eligible. Otherwise take the full path. Exe
projects keep the full path, because a match changes its callers' tiers.

## Measurement and acceptance

Scenarios: cold, warm no-op, after-N, header touch, toolchain change, revert
part, replay-N.

- Commit → preparation spawn: ≤ 0.3 s p50 on replay.
- Standalone rebuild: ≤ 1.0 s warm; after-N rebuild ≤ 0.5 s with 3.4 in place.
- Counters per rebuild: 1 inventory parse, 1 `libraryTuStatus` per member, 1
  `project.json` parse.
- **Equivalence at every replay step:**
  - the hash of the ordered `(name, decompiled, handwritten, dead)` projection
    equals a full cold rebuild;
  - `vram`, `container`, `source` and `calls` are unchanged for other readers;
  - the selected target equals the unoptimized selection under randomized
    `skip` and `defer` sets.
- Every invalidation scenario (header, toolchain, part revert) produces the
  same projection as a cold rebuild.

## Negative controls

- A rebuild failure surfaces an error rather than a stale graph.
- The documentation turn edits a header: the background graph is discarded.
- A precomputed next target is rejected after a header edit, a part revert, an
  out-of-band change to the candidate's member, or a `defer` set that names it.

## Out of scope

The exe-branch graph costs (macro census probe compiles and leaked `probe-*`
directories, per-function `resolveFunctionTarget` re-parsing the graph) are
real but outside this plan's reference project. Record them as a follow-up.
