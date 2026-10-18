# Toolchain provenance

Status: proposed, 2026-10-17. Nothing in this plan is committed.

## Goal

psyq-decomp proves that its human-readable C, and its assembly written the way
Sony wrote it, reproduce every original PSY-Q library object when built with the
toolchain Sony used.

Every accepted byte, in every harness route, has one of two origins:

- an identified tool: pinned source, a reproducible build, and a recorded hash;
- a declared stage: it stands in for a named period tool and is validated
  against that tool's real inputs and outputs.

Nothing else may change tool inputs or outputs. Verification compares against
the original object exactly, and nothing in it hides a difference.

The evidence is in psyq-decomp:

- `notes/research/compiler-identification-1997-trunk.md`
- `notes/research/assembler-identification-1997-trunk.md`

The harness audit that started this showed that harness code rewrote compiler
output (`rewriteAssemblerInput`). It also found other places where bytes were
patched or comparisons loosened.

## End state

| Stage | Tool | Provenance |
| --- | --- | --- |
| Preprocess | `cccp` from GCC trunk 1997-03-18 | psyq-decomp compiler recipe (extended) |
| Compile | `cc1` from GCC trunk 1997-03-18 | psyq-decomp compiler recipe (exists) |
| Assemble | GNU as from binutils 2.8, rolled back to trunk 1997-03-18; writes little-endian ECOFF | new psyq-decomp assembler recipe |
| GTE finalization | native DMPSX-equivalent: a declared stage, applied only to GTE placeholder words | harness implementation, validated against Sony's own HMD source/object pairs |
| Verification | candidate ECOFF object against the original LNK member, exact | harness |

Everything runs natively; there are no DOS programs and no emulators.

- **Inventory and IDs.** The original SDK objects are the inventory. Member IDs
  derive from them (`libc2_33`).
- **Converted ELF files.** The files in `library-input/redux` are a per-member
  view for disassembly and m2c, never used for acceptance and never used for an
  ID.

## Rules for every phase

1. **Provenance.** Only a pinned tool or a declared, validated stage may produce
   or change bytes. Each one is recorded in the build identity and in every
   accepted record.
2. **Exact verification.** Compare against the original object: sections,
   alignment, bytes, relocations and symbols. No masking, no folding of
   references, no target-side wildcards.
3. **Ownership.**
   - Harness code is a generic PSX/PSY-Q capability. It is tested with
     synthetic fixtures, carries no SDK bytes or consumer names, and follows
     `docs/game-agnosticity.md`.
   - Recipes, project configuration, sources, research and evidence belong to
     psyq-decomp.
4. **Fail closed.** An unknown GTE placeholder, an unmapped original, a missing
   tool hash or an original that fails the correspondence check is an error,
   never a skip.
5. **No commits** in either repository without the user's go-ahead.

## Where things land

Every phase file has the same three sections:

- **Harness (checked in here):** code, schemas, docs, tests and templates in
  this repository.
- **psyq-decomp (checked in there):** recipes, configuration, sources, notes and
  plans in `../psyq-decomp`.
- **Local only:** git-ignored outputs: psyq-decomp `build/` (built tools,
  evidence, sweeps, verified records), `run_output/` (autoloop state) and
  `library-input/` (SDK inputs). Never committed in either repository.

| Phase | Harness (here) | psyq-decomp (there) | Local only |
| --- | --- | --- | --- |
| [1 Assembler recipe](01-assembler-recipe.md) | — | `tools/binutils-recipes/gas-19970318-psx/`: the 2.8 release rolled back over all verifiable files, with a manifest | built `as` |
| [2 Period preprocessor](02-period-preprocessor.md) | split production preprocessing from dependency scanning | compiler recipe also builds `cccp`; `toolchain.json` `tools.cpp` | built `cccp` |
| [3 Original-object verification](03-original-object-verification.md) | LNK and ECOFF readers, exact comparator, `original-object` mode, ECOFF assembler output, rewrite removal, provenance records | `project.json` transitional `verification.originals`; `toolchain.json` assembler entry | — |
| [4 GTE stage](04-gte-stage.md) | DMPSX-equivalent stage, schema, tests | stage selected in `toolchain.json`; HMD validation note | Sony HMD sources under `library-input/` |
| [5 Period sources](05-period-sources.md) | Sony-style `.ASM` route, period stub generator, period include templates | 625 assembly TUs converted to `.ASM`; `include/` updated | regenerated stubs |
| [6 Switch-over](06-switch-over.md) | release notes, instruction snapshots if agent text changed | final toolchain configuration; every member re-verified | old records deleted, new records written |
| [7 Member ID rewrite](07-member-id-rewrite.md) | `psyq-lib` inventory, ID derivation, `migrate-member-ids` command | `project.json` inventory switched to the originals; IDs rewritten in `src/`, notes and configs | autoloop state migrated; records regenerated; autoloop resumes |
| [8 Harness-wide fixes](08-harness-wide-fixes.md) | `patchLibBss` byte copying removed, exact EXE check, no acceptance on function scores alone, executed-tool hashing | — | — |

## Order

```
1 assembler recipe ─┐
2 preprocessor ─────┴─> 3 verification ─> 4 GTE stage ─> 5 period sources
                                                              │
                        8 harness-wide fixes <─ 7 ID rewrite <─ 6 switch-over
```

- Phases 1 and 2 are small and can run in parallel. Phase 3 is the bulk of the
  harness work.
- **Phase 6** switches psyq-decomp's toolchain and re-verifies under unchanged
  IDs. That shows the toolchain change alone.
- **Phase 7** renames IDs as one mechanical step and re-verifies again. The
  autoloop resumes only after Phase 7.
- **Phase 8** completes the plan by applying the same rule to the rest of the
  harness.
- Until Phase 6, psyq-decomp keeps the interim state: GNU as 2.42 with the
  rewrites removed, and 299 members failing (298 because of the rewrite
  removal, plus prnt).

## Decisions

All settled:

- **D1 Member IDs.**
  - Phases 3–6 keep today's IDs, linking members to originals by a
    content-checked mapping.
  - **Phase 7 rewrites every ID** to one derived from the original object, so
    the project never ends with two schemes.
- **D2 Assembler pin.** The official binutils 2.8 release, rolled back to the
  trunk of 1997-03-18 across all 87 source files changed in between, wherever
  their history can be verified. There is one reversal patch per upstream
  change, named by its ChangeLog entry, and a per-file manifest (Phase 1).
- **D3 Sony-style assembly.** cpp-preprocessed sources using the SDK's
  `asm.h`/`inline_s.h`, register names like `a0`, GTE operations as SDK macros
  (Phase 5).
- **D4 DMPSX.** A native reimplementation, declared as a pipeline stage and
  validated against Sony's input/output pairs. No DOS program (Phase 4).
- **D5 Extension.** Sony-style assembly sources use `.ASM`.
- **D6 Records.** Old verified records are deleted, not archived. Each
  re-verification writes new records (Phases 6 and 7).

Proposed in Phase 7, confirm at its start:

- The ID format `libc2_33`.
- Whether to keep one historical old→new lookup so old commit messages stay
  traceable.

## Already done (uncommitted)

psyq-decomp:

- `toolchain.json`: `assembler.inputRewrites` is `[]`.
- `configs/project-profile.md`: regenerated.
- `notes/research/assembler-identification-1997-trunk.md`: new.
- `configs/toolchain-identification.md`: assembler update block.
- `plans/harness-rdata-section-rewrite.md`: marked superseded.
- Local evidence under `build/assembler-provenance/`.

Harness: this plan only.

## Progress

- [ ] Phase 1 — assembler recipe reproduces its expected hash; manifest covers every file
- [ ] Phase 2 — period `cccp` in production, zero byte changes across C members
- [ ] Phase 3 — original-object verification; the 178 verifiable members pass through the real gate
- [ ] Phase 4 — GTE stage; 192/192 HMD members exact
- [ ] Phase 5 — every member assembles in period syntax; stub round trip exact
- [ ] Phase 6 — 2,167/2,167 under exact verification, old IDs
- [ ] Phase 7 — IDs rewritten; 2,167/2,167 again; autoloop resumed
- [ ] Phase 8 — harness-wide fixes; no acceptance path patches, copies or masks bytes
