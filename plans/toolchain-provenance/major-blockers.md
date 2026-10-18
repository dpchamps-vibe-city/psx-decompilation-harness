# Toolchain provenance: current state and major blockers

> **2026-10-18:** the blockers below are resolved or re-scoped in
> [completion-plan.md](completion-plan.md), the single migration document. This
> snapshot is kept as history.

This is a status snapshot, not an authorization to change verification, rewrite
assembly, replace tools, or resume the autoloop. It records the current problems
without treating an inference as an identified historical tool.

The goal is an evidence-backed toolchain similar to Sony's, faithful compiled
program contents from clean C or legitimate assembly, and a completed production
migration in `../psyq-decomp`. **That migration has not happened.**

Paths beginning with `tools/` below refer to this harness unless explicitly
labelled consumer paths. Consumer evidence lives in `../psyq-decomp`; its `build/`
reports and original SDK inputs are local, ignored artifacts, not bundled inputs.

## 1. Sony's toolchain versus ours

**Sony's exact tool binaries have not been recovered.** Some stages have strong
behavioral evidence; others remain unidentified. Our period tools are installed,
but the preprocessing/assembler production switch has not happened.

| Stage | What Sony used | What Sony produced | What we have | What we produce |
| --- | --- | --- | --- | --- |
| Preprocessing | Exact preprocessor **unknown**; GCC-family origin inferred | Preprocessed C or assembly text | Rebuilt GCC `cccp`, 1997-03-18. Production still selects host CPP | Preprocessed text |
| C compilation | GCC-family compiler with behavior dated **February–March 1997**; exact Sony build unknown | MIPS assembly text | Rebuilt GCC trunk `cc1`, 1997-03-18; **production-selected** | MIPS assembly text |
| Assembly | **1997-era GNU-as-family behavior**; exact Sony implementation unknown | Machine code, data, symbols and relocations; intermediate container **not established** | Rebuilt period GNU `as`; production still selects modern GNU `as` | Period candidate: **ECOFF**. Current production: **ELF** |
| Native object encoding (1) | **Unknown**—possibly part of the assembler, possibly another tool | **PSY-Q LNK `.OBJ`** | **No identified corresponding producer** | No reconstructed LNK output |
| GTE finalization, where used | **DMPSX**, documented in the SDK/HMD workflow | Object containing finalized GTE instructions | Declared native `psyq-dmpsx` equivalent; implemented and staged | Finalized GTE instructions inside **ECOFF** |
| Library archiving | **PSYLIB** is the documented SDK librarian; Sony's internal invocation is unconfirmed | `.LIB` archives containing LNK objects | Original-library reading/extraction; no reconstructed LNK archive production | Individual candidate objects, not recreated Sony `.LIB` archives |

(1) This is a logical responsibility, **not a proven separate historical stage**.
The table does not establish the internal ordering of an unidentified encoding
step relative to other postprocessing.

The precise provenance gap is how Sony's GNU-as-family code generation produced
LNK objects. **We have not demonstrated that Sony produced ECOFF intermediates,
used a separate converter, or used our exact upstream assembler build.**
A bounded search did not identify that producer; this is not proof none exists.
The documented end-user CCPSX/ASPSX pipeline does not by itself identify the
internal producer of these GNU-built SDK library objects. Excluded SN/Libsn
members must not be generalized to the active Sony corpus.

## 2. Verification contract is unresolved

### 2.1 Program-content matching and object reproduction were conflated

The user's source-matching workflow requires compiling recovered source and
checking the underlying program contents against the originals. The plan also
requires exact cross-format object metadata and uses that stronger requirement
as a migration gate. These are different guarantees, and the implementation has
not reconciled them.

For program contents, relevant checks include every initialized code/data byte
(including padding and relocation fields), section and uninitialized-storage
sizes, symbol locations/bindings, and decoded relocation operations, references
and addends. Cross-format comparison must interpret the two relocation
representations without rewriting either object's bytes.

A hash of the entire object file is not a cross-format source-fidelity test:
LNK, ECOFF and ELF have different headers, records and potentially debug data.
Content hashes remain useful for immutable inputs, reproducible tools and
precisely defined byte regions; a full-file hash cannot make unlike containers
identical.

Conversely, matching program contents does **not** by itself establish identical
linking requirements, a drop-in replacement for the original `.OBJ`, or a
recreated `.LIB`. No revised acceptance contract has been implemented or approved
by this status document. Changing the comparator cannot establish historical
tool provenance.

### 2.2 Alignment makes the current staged native acceptance gate unsatisfiable

- Original LNK objects explicitly declare section alignment.
- The candidate MIPS ECOFF section headers do not encode a corresponding
  per-section alignment field.
- `tools/lib/objectFormats/ecoff.ts` therefore retains `alignment: null`.
- `tools/lib/objectFormats/compare.ts` records an unresolved alignment check for
  each shared section whose alignment is unknown. It returns `match` only when
  both differences and unresolved checks are empty.
- A missing original section instead produces a definite difference.

Consequently this **reader/comparator combination** cannot certify an original
with sections against these ECOFF candidates, regardless of the C spelling.
This is an obstruction in our chosen verification contract, not proof that
Sony's original program or toolchain is unreproducible.

The former reader value of 16 was borrowed from BFD's in-memory initialization;
it was not an encoded candidate declaration. That manufactured mismatch was a
bug and has been removed. Neither restoring that default, copying the target's
alignment, nor inferring a declaration from padded lengths is a sound fix.
Alignment matters to linking and cannot simply be declared equal without proof.

### 2.3 Empty section declarations also fail the current exact-object contract

LNK originals declare empty sections such as `.rdata`, `.sdata` and `.sbss` that
normal candidate output may omit. The comparator currently reports these as
missing declarations, even when all occupied storage agrees. This does not mean
initialized code/data is missing; it is still a difference under the written
section-inventory requirement. It must not be silently erased or confused with
the unavailable alignment check.

Example: unchanged clean C in `libc2/33-prnt` reproduces **424/424 instruction
words and decoded relocations** through the period pipeline. Its current native
verdict is nevertheless `mismatch`: empty `.sdata`/`.sbss` declarations are absent,
and alignment is separately unresolved.

Implementation: `tools/lib/objectFormats/{ecoff,compare,relocations}.ts`.
Consumer evidence: `build/toolchain-provenance/native-gates.json` and
`build/toolchain-provenance/compiler-online-rebuild/prnt-regression.json`.

## 3. Tool identification and reproduction have limits

### 3.1 Reproducible builds are not recovered Sony executable identities

All three period programs have successful clean online recipe replays and
reproduce our pins:

| Program | SHA-256 |
| --- | --- |
| `cccp` | `28b9f74d19c2ec220cce4fe6eec7c71b66380f932427443c9ce3aa393dce9ded` |
| `cc1` | `c4b82c51976e87e365a26c37b8281596e389ec3209ec5a59cd22ec2cf01cc686` |
| `as` | `d4ec93c0236cfa5e7fc8f6258f3345492d9a70a6ece00f19af189f7ed5fa6428` |

This establishes reproducibility of our selected builds, not binary identity
with Sony's historical tools. The compiler/assembler dates are behavioral
windows. Exact historical preprocessor, compiler and assembler builds remain
unknown, and evidence on the measured corpus does not establish that every SDK
member used one uniform compiler configuration.

The compiler's installed 450-file source capture passes the source/binary
binding verifier. Missing online inputs and the earlier incomplete compiler
replay are **resolved**, not current blockers.

### 3.2 Assembler source is a rolled-back release, not a complete trunk recovery

The assembler recipe starts from binutils 2.8 and applies verified rollbacks.
Its manifest accounts for 1,285 source files: 1,198 unchanged, two rolled back,
and **85 retained with explicit unverifiable-history reasons**. Its reproducible
build and measured output are real; a claim that the complete 1997-03-18 trunk
source tree was recovered would not be.

### 3.3 DMPSX is a declared equivalent, not the original executable

The harness implements a closed GTE-placeholder finalization operation. It is
not Sony's original DMPSX binary, nor proof of complete behavioral equivalence
to every feature or diagnostic of that program.

Independent Sony HMD source/object validation is positive: **192/192 assembly
sources compile**, and initialized bytes and relocation sites agree after
**915 declared replacements**. That validates the measured operation. It does
not establish full LNK metadata acceptance, the unidentified object producer,
or byte identity of whole object files.

Consumer evidence and research:

- `build/toolchain-provenance/compiler-online-rebuild/{report.json,build.log,source-verification.json}`
- `build/toolchain-provenance/assembler-online-rebuild/{report.json,build.log}`
- `tools/binutils-recipes/gas-19970318-psx/rollback/manifest.json`
- `notes/research/compiler-identification-1997-trunk.md`
- `notes/research/assembler-identification-1997-trunk.md`
- `build/toolchain-provenance/hmd-validation/report.json`
- `build/toolchain-provenance/manuals/provenance.json` (downloaded SDK manuals and their limits)

## 4. Source/backlog compatibility work is staged, not delivered

The current production sources and generated backlog contain modern-GAS forms.
The period assembler does not accept all of those forms. Examples include ABI
register-name syntax, modern assembly macros/directives and explicit `.reloc`
backlog emission. This is a source/generator/tool-interface issue, not evidence
that the original instructions require byte patches.

The isolated period workspace contains staged `.ASM` conversions, SDK-style
headers and regenerated symbolic backlog. These have **not** been promoted into
production. The user has explicitly rejected turning this into an assembly
rewriting/reconstructor campaign or making narrow adaptations merely to force
matches. The earlier Phase 5 mechanism therefore remains under architectural
review, not an instruction to resume that campaign.

Generated target-derived stubs are backlog scaffolding. Even an exact stub round
trip is not recovered clean C or independent compiler-identification evidence.

### 4.1 Seven staged source/generator/build-policy failures

The preserved staged population has **2,160/2,167 compiling members**. Of 625
converted assembly TUs, **623 compile**. The seven gaps are:

| Consumer source directory under `src/libraries/` | Observed failure |
| --- | --- |
| `libapi/11-c114` | Generated executable `.word 0x00007350` is rejected by source policy; instruction/data interpretation unresolved |
| `libc/6-a63` | Generated executable `.word 0x00017350` is rejected by source policy; instruction/data interpretation unresolved |
| `libgte/14-msc00` | Executable `.word` values `0x00097350` and `0x00470000` are rejected; instruction/data interpretation unresolved |
| `libgun/0-gun` | Generator reports no period section operation for `.sbss` |
| `libgun/1-newgun` | Period assembler rejects `.sbss` as an unknown pseudo-op |
| `libtap/0-tap` | Generator reports no period section operation for `.sbss` |
| `standalone/noprint` | Generator emits executable `.word 0x03e00008`, rejected by source policy; executable/data emission needs investigation |

These are observed failures, not authorization for raw instruction encodings,
policy exemptions, byte-copy fallbacks, or toolchain changes to chase scores.
The list includes policy/generator failures as well as an assembler error; it
must not be described as seven proven compiler defects.

### 4.2 Another 68 compiled candidates have differences beyond empty declarations

Among the 2,160 compiled staged candidates, **68** have known differences beyond
missing empty section declarations. Observed classes include:

- missing/additional relocation operations, or differing references/addends;
- undefined disassembler labels emitted as external imports;
- differing initialized bytes, including relocation fields;
- differing section sizes.

These remain after the relocation-reader corrections. They are candidate-level
failures requiring individual diagnosis, not evidence that alignment is the
only unfinished issue or that all original C is wrong. Some involve generated
backlog/data emission. They have not been repaired or promoted.

The complete affected-member list appears in Appendix A. Exact sites and values
are in the consumer's `build/toolchain-provenance/period-sources.json`.

## 5. Production activation and member-ID migration are unfinished

Current consumer configuration still selects:

- period `cc1`, but host `mips-linux-gnu-cpp` and `mips-linux-gnu-as`;
- GAS with ELF output, not the staged period ECOFF/DMPSX pipeline;
- converted ELF inputs under `library-input/redux` as the inventory;
- `verification.mode: "relocatable-object"`;
- old `lib_<hash>_<ordinal>` IDs.

The intended original-derived inventory, period tool selection and native
verification exist in the isolated workspace, not as the completed live switch.
Installing tools is not activating them.

`tools/agent/migrateMemberIds.ts` currently requires every old-ID member to have
an exact verification record with current provenance. Its write guard reports:

> Every old-ID member must pass exact verification with current provenance before ID migration

This couples the mechanical rename to the unresolved native acceptance contract.
A full staged dry-run covers **2,167 IDs and 4,785 files**, but no production
rename has occurred. The proposed guard change was reverted; no bypass remains.
Historical references to excluded Libsn members also have separate pending,
reference-only preparation. The staged preview must not be confused with those
changes having landed in the live project.

No planned production record deletion/republication or autoloop restart has
occurred. Existing old-mode records cannot certify the new tools/format. The
source/backlog failures above also prevent claiming a clean full-population
period build, independently of the metadata issue.

Consumer evidence:

- `toolchain.json` and `project.json` (actual live selections)
- `build/toolchain-provenance/member-id-migration-dry-run.json`
- `build/toolchain-provenance/native-gates.json`
- `build/toolchain-provenance/phase7-retired-reference-patches.json`

## 6. Evidence coverage and verification limitations

| Measurement | What it establishes | What it does not establish |
| --- | --- | --- |
| 2,167/2,167 original/ELF pairings validate | Content-checked correspondence between original members and diagnostic views | That converted ELF files may certify themselves or replace original-object evidence |
| 178 research objects; all 763 relocations agree | Matching initialized bytes and decoded relocation operands on that measured corpus | Full SDK coverage, original tool identity, or LNK metadata equivalence |
| 192 original HMD assembly sources; 915 replacements | Real-source validation of the measured GTE-finalization operation and bytes/relocation sites | Full DMPSX behavior or whole-object acceptance |
| 1,542/1,542 C-bearing objects unchanged between preprocessors | Preprocessor substitution preserves the measured resulting objects | 1,542 members decompiled to clean C or complete toolchain identification |
| Fresh `prnt` production-driver regression: 424/424 words and relocations | Matching program contents from unchanged clean C with period tools | LNK alignment/empty-declaration acceptance |
| 2,160/2,167 staged compilations | Build coverage of that workspace and its preserved candidates | Accepted source reconstruction or a completed production migration |

Under the current strict native contract, accepted whole-object counts remain
**0/178** for the research set, **0/192** for HMD, and **0** for the staged
population. These counts must not be interpreted as all machine code differing.
The datasets can overlap and must not be summed as distinct successes.

Last full harness suite: **1,567 tests, 1,444 passed, 123 explicitly skipped,
zero failures**. A subsequent small input-GP relocation correction passed the
focused native-format regressions (**3/3**); the full suite was not rerun after
that correction. Optional/asset-dependent skips and synthetic fixtures are not
project-wide native acceptance. Several older notes overstate identification or
use stale counts; the qualified claims and scoped reports above take precedence
for this snapshot.

The previously invented alignment value, reversed LNK binary-expression operand
order and incorrect cross-format relocation-addend interpretation were reader
bugs. They have been corrected; they must not be resurrected as evidence of
historical toolchain failure. No new linker/layout engine or output-patching
workaround is justified by those bugs.

## 7. Operational risk

At this snapshot the project filesystem has approximately **14 GB free (99%
used)**. `/tmp` has recovered to approximately **4.9 GB free** after an earlier
exhaustion. Neither is currently reported as blocking a command, but large clean
builds need capacity planning. This is not a reason to delete original inputs,
research evidence, existing source changes or unrelated user data.

## 8. Immediate scope

The immediate discussion is the soundness of the producer/verification contract,
particularly alignment—not repairing the other failures first. No contract
change, new converter, source rewrite or migration is authorized by this file.

The unresolved distinction must remain explicit:

1. Proving faithfully recompiled **program contents** can use a rigorously scoped
   cross-format comparison.
2. Proving an original-equivalent **linkable LNK object/library** additionally
   requires justified packaging/linking properties and an established producer.

Unknown metadata is not equal metadata. Matching program contents are not a
historical tool identity. Neither missing packaging evidence nor generated
backlog round trips should be represented as something they do not prove.

## Appendix A. All 68 compiled staged candidates with additional differences

Directories are relative to the consumer's `src/libraries/`; each owns `tu.json`.
This is a snapshot of observed differences in `period-sources.json`, not a claim
that every root cause has been identified. Empty declaration differences and
unresolved alignment are omitted from this table, not from verification.
"Missing/different" and "extra/different" include relocation operand differences
represented by the comparator as a missing original and an extra candidate row.

| Member directory | Additional observed differences |
| --- | --- |
| `libcd/4-iso9660` | missing/different relocation; extra/different relocation; initialized bytes; extra undefined external |
| `libcd/5-cdread2` | missing/different relocation; extra/different relocation; initialized bytes; extra undefined external |
| `libcd/6-cdplay` | missing/different relocation; extra/different relocation |
| `libds/9-dsfile` | missing/different relocation; extra/different relocation; initialized bytes; extra undefined external |
| `libgpu/0-font` | extra/different relocation; initialized bytes |
| `libgpu/1-fonttex` | extra/different relocation; initialized bytes |
| `libgs/80-gs_133` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgs/81-gs_134` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgs/82-gs_135` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgs/88-preset3` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgte/1-geo_00` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgte/2-geo_01` | missing/different relocation; extra/different relocation; initialized bytes |
| `libgte/223-ratan` | extra/different relocation; initialized bytes |
| `libgte/319-smp_00_5` | initialized bytes |
| `libgte/320-smp_00_6` | initialized bytes |
| `libgte/323-smp_00_9` | initialized bytes |
| `libgte/324-smp_00_1` | initialized bytes |
| `libgte/458-pmd_1` | section size; initialized bytes |
| `libgte/459-pmd_2` | section size; initialized bytes |
| `libgte/466-pmd_9` | initialized bytes |
| `libgte/467-pmd_10` | initialized bytes |
| `libgte/470-pmd_13` | section size; initialized bytes |
| `libgte/471-pmd_14` | section size; initialized bytes |
| `libgte/482-nmd_9` | initialized bytes |
| `libgte/483-nmd_10` | initialized bytes |
| `libgte/486-nmd_13` | section size; initialized bytes |
| `libgte/487-nmd_14` | section size; initialized bytes |
| `libgte/59-smp_02` | initialized bytes |
| `libgte/60-smp_03` | initialized bytes |
| `libgte/64-cmb_00` | initialized bytes |
| `libgte/65-cmb_01` | initialized bytes |
| `libgte/66-cmb_02` | section size; initialized bytes |
| `libgte/67-cmb_03` | initialized bytes |
| `libgte/68-cmb_04` | initialized bytes |
| `libgte/69-cmb_05` | section size; initialized bytes |
| `libgte/70-cmb_06` | initialized bytes |
| `libgte/71-cmb_07` | section size; initialized bytes |
| `libgte/76-cmb_12` | section size; initialized bytes |
| `libgte/78-cmb_14` | section size; initialized bytes |
| `libgte/82-cmb_18` | section size; initialized bytes |
| `libgte/84-cstbl` | extra/different relocation; initialized bytes |
| `libgte/85-cstblold` | extra/different relocation; initialized bytes |
| `libhmd/579-lwunit` | missing/different relocation; extra/different relocation; initialized bytes |
| `libhmd/580-lsunit` | missing/different relocation; extra/different relocation; initialized bytes |
| `libhmd/581-lwsunit` | missing/different relocation; extra/different relocation; initialized bytes |
| `libmath/35-arc00` | missing/different relocation; extra/different relocation |
| `libmath/36-arc01` | missing/different relocation; extra/different relocation |
| `libmath/37-arc02` | missing/different relocation; extra/different relocation |
| `libmath/38-arc03` | missing/different relocation; extra/different relocation |
| `libmath/39-exp` | missing/different relocation; extra/different relocation |
| `libmath/40-floor00` | missing/different relocation; extra/different relocation |
| `libmath/41-floor01` | missing/different relocation; extra/different relocation |
| `libmath/43-ldexp00` | missing/different relocation; extra/different relocation |
| `libmath/45-log00` | missing/different relocation; extra/different relocation |
| `libmath/46-log01` | missing/different relocation; extra/different relocation |
| `libmath/49-pow` | missing/different relocation; extra/different relocation |
| `libmath/50-sin00` | missing/different relocation; extra/different relocation |
| `libmath/51-sin01` | missing/different relocation; extra/different relocation |
| `libmath/52-sinh00` | missing/different relocation; extra/different relocation |
| `libmath/53-sinh01` | missing/different relocation; extra/different relocation |
| `libmath/54-sinh02` | missing/different relocation; extra/different relocation |
| `libmath/55-sqrt` | missing/different relocation; extra/different relocation |
| `libpress/3-build` | extra/different relocation; initialized bytes |
| `libpress/6-table` | extra/different relocation; initialized bytes |
| `libspu/21-s_sav` | missing/different relocation; extra/different relocation; initialized bytes |
| `libspu/64-st` | missing/different relocation; extra/different relocation |
| `standalone/mcgui` | missing/different relocation; extra/different relocation; initialized bytes |
| `standalone/mcgui_e` | extra/different relocation; initialized bytes |
