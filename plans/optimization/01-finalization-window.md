# Phase 1 — One verification per finalization window

Status: proposed. Depends on: Phase 0.

## Goal

Stop the loop from re-verifying what the agent's finalize call has just
verified. The post-turn window should do the scope and policy checks and the
bookkeeping, and nothing else.

Targets:
- loop post-turn window: 5.3 s → ≤ 1.0 s;
- `state.json` writes: ~100 MB → kilobytes per match.

## Where the time goes today

After the agent's turn (`.pi/extensions/psx-decomp/autoloop/loop.ts:650-748`):

1. `introducedForbiddenConstructs` (`:654`) calls `loopChangedFiles`: 8 git
   spawns over a temp index. Policy then runs outside any library-metadata
   scope, so the inventory is parsed again and the call graph loaded twice.
2. `isMatched` (`:707`): `finalizedDiff` returns `undefined` for library
   projects (`tools/finalization.ts`, last function), so `diffFunc.ts` is
   spawned again (~0.5 s).
3. `finalize` (`:736`, `oracles.ts:102`) calls `loopChangedFiles`, then the
   **entire** `finalizeWorkspace` (diff, member check and context export:
   3.3–3.5 s, 3 spawns, 2 compiles), then `loopChangedFiles` again.
4. `buildInputs()` (`:739`), then `documentMatch` → `documentCompletion` →
   `buildInputs()` again (`prepared-attempt.ts:119`), with nothing in between.
5. `writeState` (`:339`, `:367`) stringifies a 100 MB pretty-printed
   `state.json`, which grows by ~1.1 MB of `inputs` per completion.
6. After documentation: `buildInputs()` (`prepared-attempt.ts:124`), then
   `loopChangedFiles` (`loop.ts:743`), whose `diff --binary` patch goes unused.

The exe receipt (`tools/verification-receipt.ts`) cannot cover libraries.
`compilerInputs` and `verificationOutputs` hash exe artifacts, not
`library-input/**`, header roles or member profiles. Candidate directories are
also deleted after comparison, so a library check leaves no stable output to
hash.

## What the double check protects

The commit must equal the tree that was verified. Between the agent's gate and
the loop's commit, files can change through:

- parallel tool calls in the same message;
- other processes;
- a different loop config (`withLoopExemptions`);
- a different baseline (`deps.baseline` vs the session baseline).

Any reuse must still prove all of that.

## Work items

### 1.1 In-process library finalization receipt

When the library branch of `finalizeWorkspace` passes, publish a receipt into a
module-level `Map` in the extension process, keyed by project root and
function key. It is never written to disk, because the agent can write to
disk. The receipt holds:

- the target key and the sorted checked member ids;
- the end-of-window `libraryWorkspaceIdentity`, already computed at the window
  end in `finalization.ts`;
- the harness implementation identity: the Phase 2 closure once it exists,
  until then the current verification key;
- a hash of the on-disk `sourcePolicy`;
- the content hash of every checked member's accepted record;
- the content hash of the context publication files;
- the passing `GateResult` diff and build.

`finalize()` in `oracles.ts` consumes it:

1. Recompute the checked member ids from the current changed files, and every
   identity above. On any inequality, take the full path.
2. On a match, run `runGate` with `machineVerification`, so that scope and
   policy run under the **loop's** config and baseline.
3. Re-validate the receipt afterwards. This is the exe `stillFresh` pattern in
   `finalization.ts`.

`finalizedDiff` returns the receipt's diff, so `isMatched` spawns nothing.

### 1.2 One changed-files computation per window

- Split `loopChangedFiles` into "names" and "names + patch".
- Compute it once after the turn and share it between
  `introducedForbiddenConstructs` and `finalize`.
- Reuse it after `finalize` when the workspace identity is unchanged. For
  libraries, publication writes only under `build/`.
- Drop the unused patch at `loop.ts:743`.

### 1.3 Policy context parity

`introducedForbiddenConstructs` calls `checkSourcePolicy` without
`functionSources` (`oracles.ts`). For a library key, policy may then look for
`src/<member::sym>.c`.

- Verify this.
- Pass the same `functionSources`, `functionContainers` and metadata scope as
  the finalize gate, inside one `withLibraryMetadata` so the inventory is
  parsed once.

### 1.4 One input snapshot per window

- Compute `buildInputs()` once when the gate passes, and pass it into
  `documentMatch` / `documentCompletion` for the pre-documentation comparison.
- Keep the post-documentation comparison: it is the check that the
  documentation turn stayed within `notes/`.
- Run the loop window inside `withContentMemo`. Re-hash any entry whose ctime
  falls within 2 s of when it was recorded, as `cppDependencies` does.

### 1.5 Slim loop state

- A completion stores `verifiedIdentity`, plus its `inputs` map in a
  content-addressed sidecar: `<runtimeDir>/inputs/<identity>.json`, written
  once per identity.
- `sameInputs` loads the sidecar lazily.
- `writeState` writes compact JSON.
- `readState` still accepts old inline `inputs`, and migrates them on the next
  write.

## Measurement and acceptance

Scenarios: loop replay (warm and after-N), failing diff, and the negative
controls below.

- **Loop post-turn window** (finalize result → documentation prompt): ≤ 1.0 s
  p50 on the real-project bench, from 5.3 s.
- **Counters per post-turn window on a receipt hit:**
  - 0 `diffFunc` spawns, 0 member checks, 0 context exports, 0 compiles;
  - 1 changed-files computation before documentation;
  - at most 1 inventory parse;
  - at most 2 `buildInputs()` per match.
- **`state.json`:** per-match write at most 100 KB; no growth from `inputs`.
- **Equivalence:** verdicts, failure kinds, committed file lists and accepted
  records are identical to the unoptimized path across the replay.

## Negative controls (each must miss the receipt and take the full path)

- source modified between the tool call and the loop;
- an out-of-scope file changed;
- a forbidden construct added after the agent's gate;
- an owned header edited;
- `toolchain.json` or `configs/flag_overrides.mk` edited;
- a `library-input` object changed;
- a harness file in the verification identity changed;
- `sourcePolicy` changed;
- a context publication file deleted;
- an accepted record edited;
- a same-size rewrite within one timestamp tick;
- an accepted member's dependency changed;
- an input changed during the gate;
- a receipt from a different project root or function key.

Positive control: a rewrite with identical content must still hit the receipt.

## Risks

- **An input the identity misses.** Mitigation: the receipt combines the
  existing whole-window `libraryWorkspaceIdentity` with explicit
  policy/record/publication hashes, plus the full negative-control suite.
- **Receipt lifetime.** It is process-local and cleared when consumed or when
  the next function starts. It must never cross functions or sessions.

## Out of scope

Making the agent's own finalize cheaper is Phase 5. Verification-key churn is
Phase 2.
