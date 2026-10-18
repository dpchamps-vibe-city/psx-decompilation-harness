# Phase 5 — One process, one compile per gate

Status: proposed. Depends on: Phases 0 and 1.

## Goal

The agent's library finalize should do its machine work once: one inventory,
one identity batch, one compile of the active TU and one process.

Target: agent finalize 3.3–3.5 s → ≤ 1.0 s warm. A failing diff should cost
≤ 0.5 s.

## Where the time goes today

The library branch of `finalizeWorkspace`
(`.pi/extensions/psx-decomp/tools/finalization.ts`) runs three processes one
after another:

| Process | Time | What it does |
|---|---|---|
| `diffFunc.ts` | ~480 ms | re-parses the inventory; compiles the active member into a fresh uuid directory under `build/libraries/candidates` (now 1.4 GB) |
| `library.ts check --member` | ~1.1 s | re-parses the inventory; reads all accepted records; hashes the verification key; builds identities for ~790 accepted members; compiles the active member again; runs `assertUnchanged` |
| `contextExport.ts` (`tools/agent/relocatableContext.ts`) | ~1.0 s | re-parses the inventory; builds another identity batch; compiles a third time; spawns python m2c `--no-cache`; runs `assertUnchanged` twice |

Around them, `libraryWorkspaceIdentity` runs twice (310 + 160 ms).

## Work items

### 5.1 Library verification as functions

Refactor the CLIs' bodies into functions that return results:

- `diffFunc.ts`, which calls `process.exit`;
- `checkLibrary`, which prints and throws (`libraryTarget.ts:319`);
- `exportRelocatableContextScoped`.

The CLIs stay as thin wrappers for humans.

### 5.2 One shared gate operation

Inside one `withLibraryMetadata` scope:

1. Build one `libraryBuildIdentities` batch and pass it as `supplied` to export,
   which already accepts it.
2. Compile the active member once.
3. Feed that compile to the function diff, the whole-member compare, the
   record write and context export.
4. Compute the end-of-window `libraryWorkspaceIdentity` once and publish it to
   the Phase 1 receipt.

### 5.3 Run it as one child process

Until Phase 6 lands, run the shared operation in one child process, not three.
It must not run on the Pi event loop, because the synchronous work would block
the UI.

### 5.4 Content-addressed compile cache

Key compiles on the preprocessed text hash, the cc1/as/maspsx flags and the
tool identities. Store the object, not a uuid directory. This replaces the
growth of `build/libraries/candidates` and lets the diagnostics share the
compile. Failed compiles keep their diagnostics, as today.

### 5.5 Overlap where work stays separate

If any part stays a separate operation, run diff, check and export
concurrently. Context publication is staged and rolled back if the gate fails.
Check records are facts about bytes, so they stay valid even if the diff fails.

## Measurement and acceptance

Scenarios: warm pass, failing diff, policy failure, header touch, after-N.

- Agent finalize p50: ≤ 1.0 s warm on the bench.
- Counters per finalize: 1 process (or 0 after Phase 6), 1 inventory parse,
  1 compile of the active TU, 1 identity batch.
- `build/libraries/candidates` no longer grows on matches.
- **Equivalence:** verdicts, failure kinds, accepted records, context
  publication files and receipt contents are identical to the three-process
  path, across the replay and the Phase 1 negative controls.

## Risks

- **Ordering.** Today context export runs only after the gate passes. With
  staging, a failed gate leaves no published context. Test that the files are
  restored after a failure.
- **Error reporting parity.** Failure messages the agent sees (the diff
  summary, the member verdict, the publication failure) must keep the same
  text and fields.
