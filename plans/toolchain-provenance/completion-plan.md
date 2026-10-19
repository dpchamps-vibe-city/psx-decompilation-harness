# Toolchain provenance: migration plan

The single document for the migration. Older files in this directory are
history. Nothing has been committed.

Repositories: the harness (this repository) and `../psyq-decomp`. Evidence for
every measured number is under `../psyq-decomp/build/toolchain-provenance/`
(git-ignored).

## Current execution status — overriding no-assembly rule

The user's later instruction **forbids assembly reconstruction and target-fitted
transformations**. It supersedes the assembly-writing approval below and the
source-rewriting requirements of step 4.4. Those requirements and the original
"Done when" conditions are preserved below, not silently redefined as complete.
The original remediation permitted only explicitly original-derived, build-local
stub extraction. The user has since explicitly requested retaining that existing
mechanical assembly output in the repository for handwritten-classified members.
This authorizes unchanged extracted files with provenance, **not** reconstructed
assembly, source translation, label/instruction changes, or target-fitting.

The retained form uses `handwritten.ASM` and `handwritten-symbols.ASM`, with
original/file hashes and `format: "assembler-with-cpp"` in `tu.json`. These are
verbatim copies of the established unpreprocessed assembly inputs. CPP drivers
and preprocessed `.s` outputs stay under `build/`; the mistaken retained `.s`
copies were removed. This supersedes the earlier blanket build-local-listing
restriction only for these classified members. Existing C and preserved source
are unchanged.

The compliant migration and remediation are verified:

- Removed 681 agent-produced assembly files and the prefix-splicing rule;
  quarantined the source-rewriting drivers. Also removed 642 withdrawn assembly
  copies and five forbidden SDK header copies from the index, preserving every
  unrelated staged blob and mode (with an index backup). Preserved 624 original
  assembly files verbatim, uncompiled; their recorded hashes still agree. All 825
  assembly TUs use extraction wrappers, not reconstructed assembly.
- Regenerated every stub; `library -- check-splits` passes **2,164/2,164**.
- Deleted verification records and reran the real `npm run check-all` through
  the native opt-in test: **2,164/2,164 whole original/rebuilt .OBJ hashes agree**;
  the opt-in test passes. Tool binaries, flags and native acceptance were not
  changed to fit these results. Extraction backlog is not reconstruction.
- `npm test`: **1,531 passed, 123 explicitly skipped, zero failed** (1,654 total).
- Fresh graph: 3,166 inventory functions each have exactly one TU part; the
  autoloop's eligible set is exactly **2,176 C-stub functions**, minus zero
  parked functions. All 870 functions in assembly TUs are excluded.
- Regenerated the project profile. SDK header copies and generated listings
  are absent from tracked source additions. No commits were made.

**Not fulfilled:** the 59-live-source condition requires the prohibited 43
assembly restorations. The all-28-inline-attempt condition is also not fulfilled:
original assembly is not generally lexically embeddable in period `cccp`, even
under `#if 0`; it is preserved unchanged outside preprocessing rather than
repaired. The 16 C restorations remain live; `libc2_12` remains disabled.
The user still starts `/auto_decompilation_loop` in the project's Pi TUI;
this session has not started it or claimed that it is running.

Current evidence in psyq-decomp:
`build/toolchain-provenance/completion-status.json`,
`provenance-remediation.json` and `harness-verification/*-final.log`.
The earlier `completion-report.json` and restoration/promotion counts are
historical and superseded, not current source-provenance evidence.

## Goal

At the end:

1. Every selected member is in the project, and each of its functions belongs
   to exactly one translation-unit part.
2. `npm run check-all` passes. For every selected member:

   ```
   sha256(rebuilt .OBJ) == sha256(original .OBJ)
   ```

3. The autoloop runs on psyq-decomp.

## Scope

Selected: the 2,164 members Sony built with the toolchain below. These are all
members of the 20 archives in `project.json`, plus `MCGUI.OBJ`, `MCGUI_E.OBJ`,
`NOPRINT.OBJ` and `POWERON.OBJ`.

Not selected, each recorded in `configs/conversion-policy.json`:

| Input | Members | Reason |
| --- | ---: | --- |
| `Libsn.lib` | 59 | SN Systems' runtime, built with SN's toolchain (dropped 2026-10-17) |
| `2MBYTE.OBJ`, `8MBYTE.OBJ`, `NOHEAP.OBJ`, `NONE3.OBJ` | 4 | SN-built. Neither of Sony's section headers; `NOHEAP` and `NONE3` have `.ctors`/`.dtors` sections like Libsn's startup |
| `LIBGUN.LIB` (`GUN`, `NEWGUN`) and `LIBTAP.LIB` (`TAP`) | 3 | Assembled by an assembler we don't have. They return when it is found (`older-build-assembler.md`) |

2,164 + 59 + 4 + 3 = 2,230, the SDK's full entry count.

## Toolchain

| Step | Tool | Pin |
| --- | --- | --- |
| Preprocess | `cccp`, GCC trunk 1997-03-18 | `28b9f74d19c2ec220cce4fe6eec7c71b66380f932427443c9ce3aa393dce9ded` |
| Compile | `cc1`, GCC trunk 1997-03-18 (gcc-mirror `2b3600acb4ec`) | `c4b82c51976e87e365a26c37b8281596e389ec3209ec5a59cd22ec2cf01cc686` |
| Assemble | GNU as, binutils 2.8 rolled back to 1997-03-18, writing ECOFF | `d4ec93c0236cfa5e7fc8f6258f3345492d9a70a6ece00f19af189f7ed5fa6428` |
| GTE commands | `psyq-dmpsx` (harness) | implementation hash |
| Object file | `psyq-lnk` (harness): ECOFF in, Sony `.OBJ` out | implementation hash |

Flags:

- `cc1`: `-O3 -G0 -mips1 -mcpu=r3000 -funsigned-char -fpeephole -ffunction-cse -fpcc-struct-return -fcommon -fverbose-asm -msoft-float -mmips-as -fno-exceptions -fgnu-linker -quiet`
- `as`: `-EL -G0 -mips1`, for every member
- `cccp`: `-nostdinc -undef -D__GNUC__=2 -lang-c -D_LANGUAGE_C`, or for `.ASM`
  files `-lang-asm -D_LANGUAGE_ASSEMBLY -D__ASSEMBLER__`

Profile `sony-early` is `assembler.lnkLayout: "early"` and nothing else. Only
`POWERON.OBJ` uses it, and it rebuilds identical.

| Layout | Section declarations, in file order (name = ID) | Empty sections |
| --- | --- | --- |
| `standard` | `.rdata`=0xF001 `.text`=0xF002 `.data`=0xF003 `.sdata`=0xF004 `.sbss`=0xF005 `.bss`=0xF006 | written with a SWITCH record |
| `early` | `.rdata`=0xF004 `.text`=0xF000 `.data`=0xF001 `.sdata`=0xF003 `.bss`=0xF005 `.sbss`=0xF002 | omitted |

## Decisions

| Decision | Status |
| --- | --- |
| Optimisation level `-O3` | approved |
| Members whose original was produced from assembly are written as assembly, including the 88 `PSX_BIOS_*` wrappers | approved |
| `psyq-lnk` is part of the toolchain | approved |
| Earlier builds are supported through the `early` layout, which POWERON witnesses, and through nothing else without a byte-identical witness | approved |
| Drop `LIBGUN` and `LIBTAP` now; look for their assembler while the autoloop runs, as a separate task (`older-build-assembler.md`) | approved 2026-10-18 |
| The `AGENTS.md` change is the user's. The decompilation skill keeps its "No internet research" rule | approved 2026-10-18 |

## Rules

- No tool reads an original object to produce a candidate. Stub generation
  reads originals; it is the extraction step.
- No masking, waivers or per-member exceptions in the check.
- A generator or converter rule is added only together with an original it
  makes byte-identical.
- A reconstructed source is never replaced by a stub. If it doesn't match, it
  stays in its part as a disabled attempt, and the member builds from its stub.
- Nothing from the SDK and no generated listing is tracked in git.
- Harness code carries no SDK bytes and is tested with synthetic fixtures.
- No commits without the user's go-ahead.

## Steps

### 1. Scope (psyq-decomp)

1. In `project.json`, remove `LIBGUN.LIB` and `LIBTAP.LIB` from
   `target.archives`, and set `memberProfiles` to `{ "poweron": "sony-early" }`.
2. Remove `src/libraries/libgun/` and `src/libraries/libtap/`, as was done for
   Libsn. NEWGUN's converted source stays in git at
   `fa874bb3:src/libraries/libgun/1-newgun/newgun.s`.
3. In `configs/conversion-policy.json`:
   - add `excludedArchives` entries for `LIBGUN.LIB` (2 entries) and `LIBTAP.LIB`
     (1), with the reason above and the evidence path
     `build/toolchain-provenance/fix-research/early/`;
   - record the four SN-built standalone objects the same way;
   - rewrite `scopeNote` to the scope above.
4. In `configs/deferred-sdk-objects.json`, mark the four standalone objects and
   the two Libsn entries as excluded and SN-built, with
   `countsTowardFullSdkCompletion: false`.
5. In `toolchain.json`, reduce `profiles.sony-early` to its `assembler` block
   with `lnkLayout: "early"`, and remove its `as` flags.
6. In `configs/toolchain-identification.md`, replace the `sony-early` evidence:
   POWERON only, `-G8` unused, and GUN, NEWGUN and TAP dropped, with the reason.
   Remove the statements that `.lcomm` places data in `.sbss`.

### 2. Toolchain configuration (harness)

1. Delete the `-G8` exception at `tools/lib/toolchain.ts:85`. `gas` still
   requires `-G0`.
2. The generator rejects `.sbss` data; no selected member has any. Remove the
   `.lcomm` path added for earlier item 4.6.
3. Add the missing `psyq-lnk` tests:
   - a patch crossing a BYTES boundary;
   - an unknown layout;
   - a relocation target that is not a section;
   - several REFHI before one REFLO;
   - a lone REFLO with a non-zero section base.

### 3. Stub generator (harness, `tools/lib/libraryAssembly.ts`)

Each rule uses only the original's LNK records and the generated listing.

1. **Symbol part.** Generate
   `build/libraries/nonmatchings/<id>/__library_member_symbols.s`.
   - For each ID from the TU's first free ID up to the highest ID with a record:
     - write `.globl <name>` when the ID has a record (XDEF, XREF or XBSS);
     - write the local label `__lnk_hidden_<id>:` when it has none.
   - The first free ID is 3 in a C TU (after cc1's two markers) and 1 in an
     assembly TU.
   - The part comes first in its TU:
     - a C TU lists a one-line `INCLUDE_ASM` part for it first in `tu.json`;
     - an assembly TU `.include`s it before its first section directive.
   - Every TU with a stub part gets it. So do the restored sources in step 4
     that match only with it.
   - It is a generated part like `__library_member_data`: not a function and
     never an autoloop target.
   - A member counts as finished only when its TU has no generated part left,
     this one included.
2. **Local labels.** Every other label the generator writes is a `$L…` label,
   except labels that a C or assembly part of the same TU refers to by name.
3. **Delay slots filled by the assembler.** A delay slot was filled by the
   assembler when either:
   - its instruction's patch comes before the jump's own JMPADDR patch in the
     original; or
   - it holds a REFLO whose REFHI comes before the branch.

   For such a slot:
   - Write that instruction before its branch.
   - Wrap three instructions in `.set reorder` … `.set noreorder`: the one before
     them, the moved instruction and the branch. The region starts one
     instruction early because gas fills a slot only when the instruction two back
     was assembled in reorder mode.
   - Drop unreferenced labels between the branch and its slot. A referenced label
     on the slot instruction turns the rule off.
4. **Data words.** A `.word` in a data section names a symbol only where the
   original has a patch on that word. Otherwise it holds the original value as a
   number.
5. **Register moves.** Where the original word is `or rd, rs, $0`, write
   `or rd, rs, zero` (`asm.h` register names); `move` assembles as `addu`.
6. **Generated stubs stay under `build/`.** An assembly-origin stub's listing is
   generated beside the C-origin listings. The tracked `backlog.ASM` holds only
   the `.include` of it, plus any disabled attempt.
7. **No instruction re-rendering.** Delete `tools/lib/r3000.ts` and its uses in
   the generator; spimdisasm's output stands, because generated listings are not
   sources.

Measured in simulation, with rules 1–5 applied:
- every stub of the 2,164 selected members rebuilds identical;
- no member that is identical today changes.

Evidence: `fix-research/c-stubs/R123.json` and `fix-research/asm-stubs/results/`.

Tests:
- one synthetic ECOFF-mode test per rule;
- ECOFF-mode tests for the existing items 4.1–4.5, which have none.

### 4. Restore the 88 replaced reconstructions

The members are listed in `fix-research/demoted-members.tsv`.

In the harness:

1. **Disabled attempts pass the source checks.**
   - `inspectLibraryPart` uses the active-code walk that skips `#if 0` arms
     (`tools/agent/cSourceAnalysis.ts:197-207`) instead of raw top-level nodes
     (`tools/lib/libraryTranslationUnit.ts:146-153`).
   - `inspectAssemblyPart` (`:120-135`) and `tools/lib/assemblyPolicy.ts:31-39`
     skip `#if 0` arms too.
2. **Library park works like the executable park.** For each part the attempt
   changed, the live text goes back to its stub, and the attempt follows under a
   park header inside `#if 0`. The change is in
   `.pi/extensions/psx-decomp/autoloop/park.ts:136-139`; the form to copy is at
   `:73-93`.
3. **Prep uses a preserved attempt.** When a part holds a disabled attempt,
   library prep (`tools/agent/libraryTarget.ts:413` onward) uses it as the
   primary draft instead of the m2c draft.

In psyq-decomp:

4. Restore these as live sources, with the symbol part first. Each was measured
   identical in simulation.
   - **16 of the 17 partly decompiled C members**, from their parts at
     `fa874bb3`, with regenerated stubs.
   - **43 assembly members**, from the period-spelled sources in
     `build/toolchain-provenance/period-workspace/src/`, with each source's own
     local labels written as `$L…`. The list is in
     `fix-research/asm-stubs/results/demoted-workspace.json`.
     - `libgte_29` also needs rule 3's form at its delay slots, written into its
       source.
     - `libpad_20` becomes an assembly TU: its matching source is assembly, and
       its IDs 1–2 are named locals, not cc1's markers.
5. Keep these as disabled attempts behind the live stub:
   - `libc2_12`, from `fa874bb3`. At `-O3`, cc1 inlines `_putchar` into
     `putchar`, so the C needs a change.
   - The 27 `libgte` smp/pmd/cmb members, from the workspace. Each differs by an
     extra `nop` that the period `as` adds before a GTE command following
     `lwc2`.
6. Remove both entries from `parked` in `run_output/autoloop/state.json`. Both
   are stale:
   - `libc2_33::prnt` now matches;
   - `libapi_73::func_0000031C`'s C matches as part of the restored `libapi_73`.
     Its park only recorded a configuration-parser error that the harness no
     longer has.

### 5. Sony material out of git

1. **SDK headers.** The period `cccp` doesn't join CRLF continuation lines, so
   it reads the `headers.reference` directories through an LF-normalized copy
   under `build/`.
   - Implement this where include directories become `-I` flags
     (`tools/lib/toolchain.ts:227`), keyed by the headers' content.
   - Then delete `include/assembly/` and `include/stdarg.h` from psyq-decomp, and
     remove `include/assembly` from `includeDirs`.
2. **BIOS wrappers.** Delete the cc1 banner and option lines from the 88
   `PSX_BIOS_*` `.ASM` files.
3. **Header comments.** Change the generator so each `_shared-0.h` gives its
   original as the member's archive, ordinal and LNK sha256, instead of
   `library-input/redux/*.o`. Update that line in the 1,342 existing headers.

### 6. Harness defects

1. **`tools/agent/decompToolchain.ts:776`.** Use the section map's key. The code
   reads `s.name`, which doesn't exist, so disassembling a whole `.OBJ` throws.
2. **Stub status.** Take it from the TU manifest (`libraryTuStatus`), not from
   `.NON_MATCHING` symbols. The places are
   `tools/lib/relocatableFunctionOracle.ts:103-104` and
   `tools/agent/matching-reconstruction/library-engine.ts:126`.
3. **Static functions.** Look them up in the sibling `<object>.ecoff`, which
   keeps local names, so a static function can be compared before its member
   matches (`tools/lib/relocatableFunctionOracle.ts:93-95`).
4. **LNK candidates.** Read candidate words through `readRelocatableObject`
   instead of `objcopy`/`objdump`, which can't read LNK. The places are
   `tools/agent/source-shape-search/evaluator.ts:98-99` and
   `tools/agent/recipe-atlas/atlas.ts:106`.
5. **Source check.** In code sections of a source, reject every data directive:
   `.word`, `.half`, `.byte`, `.int`, `.long`, `.fill`, and `.space` with a
   non-zero fill (`tools/lib/assemblyPolicy.ts:31-39`).
   - The exceptions are known DMPSX placeholders and `.ascii`/`.asciz` of
     printable text.
   - This replaces the relaxed rule of earlier item 4.7.
6. **Failure output.**
   - The thrown error and the `check-all` summary carry the first differing
     record (`tools/agent/libraryTarget.ts:363`, `:389`).
   - `tools/lib/containerAcceptance.ts:25` puts the child's stdout in its error.
   - A mismatch writes a record with both hashes, the first differing record and
     the candidate's path.
   - Replace the "Scope: whole relocatable member (sections, bytes, symbols…)"
     line with the hash wording.
7. **Build directories.** Delete a successful compile bundle even when it holds
   an `.ecoff`, and keep only the newest bundle per member
   (`tools/agent/libraryTarget.ts:372`).
8. **Autoloop targets.** In `writeLibraryGraph`
   (`tools/agent/libraryTarget.ts:233-268`):
   - a function is a C target exactly when its member's TU is a C TU and its
     part is a stub;
   - every function of an assembly TU is `handwritten: "asm"`;
   - the code classifier (`tools/agent/libraryCodeClass.ts`) no longer excludes
     functions by itself. (Amended 2026-10-18: split records each fingerprinted
     function of a C member as `retained` in its `tu.json`; the graph excludes
     a function only through that explicit, revalidated flag.)
9. **Type errors.** Fix the five new ones:
   `tools/lib/libraryTranslationUnit.ts:173`, `tools/lib/objectFormats.test.ts:67`,
   `:68`, `:142`, and the one in item 1.
10. **Unused template.** Delete `templates/period/include/macro.inc`.
11. **Python script.** Rewrite
    `../psyq-decomp/tools/gcc-recipes/trunk-19970318-psx/install.py` in
    TypeScript, as the gas recipe's `install.ts` already is.
12. **Docs.** Update `docs/toolchain.md`, `docs/library-targets.md` and
    `.pi/skills/psx-bootstrap-project/SKILL.md:3,35,41` to describe:
    - Sony `.LIB`/`.OBJ` targets;
    - the `early` layout as above, and `-G0` only;
    - the generator rules, disabled attempts and the header copy.

### 7. Rebuild and verify (psyq-decomp)

1. Regenerate every stub and listing with `npm run split-all`, then run
   `npm run library -- check-splits`.
2. Regenerate `configs/project-profile.md`.
3. In the harness, record the instruction snapshot with
   `npm run test:update-instructions`, then run `npm test`.
4. Delete `build/libraries/verified/`, then run `npm run check-all`.

### 8. Start the autoloop

Run `/auto_decompilation_loop` in a Pi TUI opened in `../psyq-decomp`. The user
starts it; the harness can't.

## Done when

- `npm run check-all` passes: 2,164 of 2,164 members are identical.
- Every inventory function belongs to exactly one TU part.
- Of the 88 replaced reconstructions:
  - 59 are live, matching sources;
  - 28 are disabled attempts in their TUs;
  - NEWGUN left with LIBGUN.
- `npm test` passes in the harness, including the opt-in
  `tools/agent/nativeLibraryAcceptance.test.ts`.
- The autoloop's targets are exactly the stub functions of C TUs, minus parked
  ones, and a park leaves `check-all` passing.
- No SDK header and no generated listing is tracked in git.

## Historical build (2026-10-18; superseded)

The assembly promotion/restoration claims in this section were subsequently
withdrawn. See the current execution status above; matching object hashes did
not make those source transformations acceptable.

The earlier version of this plan (steps 1–8) was executed. The code and the docs
hold the detail.

| Step | Where | Result |
| --- | --- | --- |
| `psyq-lnk` | `tools/lib/stages/psyqLnk.ts`, `tools/lib/objectFormats/lnkWriter.ts` | HMD validation 192/192; makefile replay 551/575 |
| DMPSX C table | `tools/lib/stages/psyqDmpsx.ts` | 65/65 agree with the documented table |
| Hash acceptance | `tools/agent/libraryTarget.ts`, `tools/lib/objectFormats/byteCompare.ts` | Whole-file SHA-256 on every path; records hold both hashes and the tool pins |
| Generator items 4.1–4.7 | `tools/lib/libraryAssembly.ts` | 4.6 and 4.7 are replaced by steps 2 and 6 above |
| Sources | psyq-decomp | All 88 BIOS wrappers, `prnt` and both `sprintf` match |
| HMD replay | `../psyq-decomp/tools/replayHmd.mts` | 551/575; the other 24 are listed in the compiler note §8 |
| Switch | psyq-decomp `toolchain.json` and `project.json` | 2,167 build; 1,849 identical; 318 stubs differ |
| Member IDs | `tools/agent/migrateMemberIds.ts` | `<archive>_<ordinal>`; results unchanged across the rename |

The switch replaced 88 reconstructions with stubs; step 4 restores them. The
run's report is `../psyq-decomp/build/toolchain-provenance/completion-report.json`.

## References

- `older-build-assembler.md`, the separate task for `LIBGUN` and `LIBTAP`
- `../psyq-decomp/notes/research/compiler-identification-1997-trunk.md`
- `../psyq-decomp/notes/research/compiler-identification-methodology.md`
- `../psyq-decomp/notes/research/assembler-identification-1997-trunk.md`
- `../psyq-decomp/notes/research/assembler-identification-methodology.md`
- `../psyq-decomp/build/toolchain-provenance/lnk-encoding-research/`
- `../psyq-decomp/build/toolchain-provenance/compiler-window-bisect/`
- `../psyq-decomp/build/toolchain-provenance/fix-research/`:
  - `c-stubs/`, `asm-stubs/` and `early/`, each with a README;
  - `demoted-members.tsv`;
  - `check-all-failures.txt`.
