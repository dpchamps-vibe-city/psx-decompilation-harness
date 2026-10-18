# Toolchain provenance

> **2026-10-18:** for execution, use [completion-plan.md](completion-plan.md), the
> single migration document. This file and the phase files are kept as history.

Current status: the compliant completion-plan migration passes all 2,164 native
whole-object hashes, split checks, the harness suite and native opt-in test.
Assembly reconstructions and fitting hooks were withdrawn; conflicting assembly
restoration goals are **not fulfilled**. The user must start the TUI autoloop.
See the execution status in `completion-plan.md`; the Progress section below is
historical. Nothing is committed.

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

## Progress

Implementation and **passing project activation gates** are distinct. The
previous universal alignment-blocker claim was caused by a verifier bug and is
withdrawn; see the correction below.

| Phase | Implemented / measured | Activation status |
| --- | --- | --- |
| 1 | Complete recipe, installer, rollback manifest and smoke tests. Two clean offline builds reproduce `d4ec93c0236cfa5e7fc8f6258f3345492d9a70a6ece00f19af189f7ed5fa6428`. All 1,285 source files accounted for: 1,198 unchanged, 2 rolled back, 85 retained with unverifiable-history reasons. | A fresh GNU download and clean online Dockerfile replay also reproduce the pin; installed, not selected in production. |
| 2 | Production preprocessing separated from dependency discovery; recipe builds and pins cccp. Two clean cccp builds reproduce `28b9f74d19c2ec220cce4fe6eec7c71b66380f932427443c9ce3aa393dce9ded`. Full C population: **1,542/1,542 identical objects**, zero failures. | Production selection waits for Phase 6. The full Docker recipe has now been replayed online with its pinned upstream inputs: cc1 and cccp both reproduce their existing hashes, and the complete source capture is installed and verified. |
| 3 | Native readers, exact comparator, original mapping, native diagnostics/private function bounds, pins/receipts and opt-in real-project CLI test. **2,167/2,167 ELF/original pairings validate.** The strict comparator reports **0/178** research objects exact. | Not accepted; known differences and unavailable checks are reported separately. |
| 4 | Closed DMPSX stage, unknown/relocated-placeholder rejection, complete operand tests. Actual Sony HMD sources: **192/192** compile; initialized bytes and relocation sites agree after **915** replacements. Full native acceptance: **0/192**; metadata checks do not establish acceptance. | Operation validated; required whole-object gate failed. |
| 5 | `.ASM` route, SDK-style symbolic generator, source policy and period templates (tested with the pinned assembler). All **625** assembly sources converted in an isolated workspace; **623** assemble. Across the full population **2,160/2,167** compile; **0** are native-exact. Seven source/generator gaps remain: three `.sbss` cases and four ambiguous executable-word/data cases. | No non-exact source promoted. |
| 6 | Final configurations staged; the real `check-all` CLI exercised under old IDs. It rejects the first member despite **4/4 instruction words** agreeing, naming missing empty declarations and separately reporting unavailable alignment checks. | No production switch or record deletion. |
| 7 | `psyq-lib` inventory, original-derived IDs, transactional dry-run-first migration, runtime state/attempt paths and active-loop lock. Full staged proposal covers **2,167 IDs / 4,785 files**, after separately preparing historical references to the excluded Libsn members. Write correctly refuses without fresh native matches. | No production IDs/state changed; loop remains stopped. |
| 8 | SDK object/data/BSS mutation retired; converter identity/arguments recorded; exact image header/length checks; whole-container publication gate; executed tools/packages/libraries hashed and pins checked. | Harness tests pass. |

### Correction: invented alignment was a verifier bug

The ECOFF reader previously assigned every section `alignment: 16`, borrowing
BFD's in-memory initialization default. It then compared that invented value
with the original LNK's encoded alignment (usually 8). This manufactured a
blanket mismatch. The resulting claim that all 2,167 members were inherently
unreproducible was unjustified and is withdrawn.

ECOFF alignment is now explicitly `null` (not encoded). The comparator reports
required checks without evidence in `unresolved`, separately from witnessed
`differences`. Otherwise-equal content with unavailable alignment yields
`UNDETERMINED`, not `MATCH` or a fabricated alignment mismatch. Real differences
still yield `MISMATCH`, including missing empty section declarations under this
plan's exact section contract. Missing declarations do not imply missing code
or data when their size is zero.

This corrects the reader and the diagnosis without relaxing acceptance. The
ECOFF/LNK format boundary still needs independently established evidence for
checks the candidate does not encode. It is not a proof that changing source
or using the identified tools cannot reproduce the program. The earlier 178/178
byte/relocation-site result remains valid within its stated scope, not as full
native acceptance.

The same audit corrected a second reader bug: LNK binary expressions serialize
the right operand first. Subtraction/division now retain their correct semantic
operand order, and view correspondence no longer mistakes `constant - symbol`
for a positive symbol relocation. Raw records and full trees, including `+0`,
remain unchanged; no reference folding was introduced. All 2,167 view pairings
still validate.

A third verifier correction decodes relocation operands according to each
format: LNK's explicit expressions versus ECOFF's in-place addends, section-VMA
adjustment and signed HI/LO pairing. This reads symbolic operands; it does not
apply relocations, place sections or alter bytes. All 763 research relocations
across 178 objects now agree. Their remaining known differences are empty
section declarations; alignment remains unavailable. Diagnostic consumers use
the same decoded operands rather than counting in-place addends twice.

### Evidence and verification

Consumer-local reports under `build/toolchain-provenance/` include
`cpp-population/report.json`, `correspondence.json`, `hmd-validation/report.json`,
`period-sources.json`, `native-gates.json`, `alignment-requirement.json` (now an
explicit withdrawal/correction of the old claim),
`compiler-online-rebuild/report.json` and the pending member-ID/reference plans.
The full online compiler replay reproduces cc1
`c4b82c51976e87e365a26c37b8281596e389ec3209ec5a59cd22ec2cf01cc686`
and the cccp pin above. The installed 450-file source capture passes the existing
compiler-source verification command; neither installed executable changed bytes.
Harness-local logs include `build/toolchain-provenance/relocation-fix-check-all.log`,
`relocation-fix-full-tests.log` and `relocation-operands-tests.log`.

Last full harness suite: **1,567 tests; 1,444 passed, 123 explicitly skipped, zero failed**.
Subsequent focused native operand regressions also pass, including an encoded
ECOFF input-gp header; the full suite was not rerun for that final small correction.
The skips include opt-in real-project/installed-runtime tests, not disguised
native acceptance. Instruction snapshots pass without agent-text changes.
Final provenance controls also bind native diagnostic artifacts/publication to
both original inputs and validated ELF views, reject stale invocation-local
models and escaped views, and hash the declared stage's reader dependencies.
Assembly policy audits original and expanded source, including local defines;
header-hidden instruction words are rejected in both sync and async builds.
The synthetic native integration test now rejects unproven metadata and creates
no accepted record, even when all instruction words agree. Its generated
symbolic stubs preserve known content, and a changed instruction still produces
a definite mismatch. The old purported native success depended on the same
invented alignment and was not a valid acceptance test.

Original inputs, production tool selections, verified records, member IDs and
consumer autoloop state remain unchanged; only the retired empty rewrite key
was removed from the live toolchain schema configuration. No commits were made.

- [x] Phase 1 — reproducible assembler recipe and complete manifest
- [ ] Phase 2 — production activation (population comparison passed)
- [ ] Phase 3 — required 178/178 strict native acceptance
- [ ] Phase 4 — required 192/192 strict native HMD acceptance
- [ ] Phase 5 — all sources/stubs compile and are native-exact
- [ ] Phase 6 — 2,167/2,167 native-exact under old IDs
- [ ] Phase 7 — gated production rename/reverification and loop resume
- [x] Phase 8 — implemented harness-wide fixes and passing tests
