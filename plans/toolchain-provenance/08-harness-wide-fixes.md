# Phase 8 — Harness-wide provenance fixes

Status: proposed. Depends on:

- Phase 3: the plaintext provenance records and the exact-comparison
  principles.
- Phase 7: so the plan finishes with every route held to the same rule.

## Goal

Hold every harness route to the rule the library route now follows. Accepted
bytes come only from identified tools or declared, validated stages, and checks
compare exactly.

These are the 2026-10-17 audit findings outside the library route. All of the
work is harness code (checked in here). psyq-decomp is not affected. EXE
projects must re-run their own checks after it lands, and anything that only
passed because of the removed code then fails.

## Work

### Harness (checked in here)

1. **Stop patching SDK objects before linking (`tools/build/patchLibBss.ts`).**
   - Delete the data copying, `patchDataBytes`/`patchRdataBytes`
     (`:517-611`). They overwrite every non-relocated `.data`/`.rdata` byte
     that differs from the original game binary, which makes `check-exe`
     circular for those bytes.
   - Move the HI16 carry fix (`patchHi16Carry`, `:453-511`) to where the
     problem arises: the configured LNK→ELF converter. Make it an explicit,
     identified converter option, or a declared conversion stage validated
     against converter output. Never apply it unconditionally to every linked
     object.
   - Express BSS placement only in the linker script (`patchLinkerBss.ts`,
     `lib_bss_syms.txt`). Stop rewriting symbol tables to `SHN_ABS` and zeroing
     `.bss` headers.
   - The linker script links the converter's objects directly. The
     `build/lib` patched copies go away.
2. **Exact EXE comparison (`tools/build/pipeline.ts`, `verifyContainer`).**
   - Compare the payload with an exact length check: a built image longer than
     the declared payload fails.
   - Check that the built PS-X EXE header fields (entry point, gp, load
     address, payload size) equal the original's.
3. **No acceptance on function scores alone.** `tools/agent/finalizeEngineMatches.ts`,
   campaign `integration` and `artifact-overlay` must run the full container
   check (`check-all`/`check-exe`, or library `check --member`) before writing
   or publishing. If that check is unavailable they stop, rather than
   printing a reminder.
4. **Hash what executes, check pins at acceptance:**
   - maspsx identity: hash the `maspsx` package directory, not just the
     `maspsx.py` stub;
   - host-tool identity: for dynamically linked binutils, hash the linked
     `libbfd`/`libopcodes` as well, or record the package version and refuse
     unknown ones;
   - acceptance verifies the configured compiler's pin (`verifyCompilerBinding`)
     and each recipe tool's expected hash on every run, not only at install.
5. **Converter identity on the EXE route (`splitSdkLibs.ts`).** The
   `preexisting-elf` fallback accepts objects that "may carry earlier
   corrections" and uses the object's own hash as its "converter" hash. Require
   an identified converter, or label those objects as unverified inputs.
6. **Source policy for assembly.** Reject raw `.word` instruction encodings in
   hand-written executable sections everywhere, not only in library assembly
   TUs (shared with Phase 5).

#### Docs and tests

- Docs:
  - `docs/toolchain.md`: the provenance rule, and what counts as a declared
    stage;
  - `docs/bootstrap.md`: the converter option for the HI16 carry.
- Tests, synthetic:
  - the EXE check fails on a header field change and on trailing bytes;
  - a linked SDK object with a data difference fails `check-exe`;
  - the engine-match writers refuse without a container check;
  - the identity changes when a maspsx package file or a pinned tool changes.

### psyq-decomp (checked in there)

Nothing.

### Local only

Nothing.

## Acceptance

- `rg` finds no harness code that writes the target's bytes into a candidate,
  copies relocation tables from a target into a build, or masks bytes in an
  acceptance comparison.
- All tests pass. An EXE fixture project with a deliberate SDK-data difference
  fails `check-exe`.
- `docs/toolchain.md` states the rule and lists every declared stage. At the
  end of this plan that is one stage: `psyq-dmpsx`.

## Out of scope

Building verified libraries into objects that EXE projects link instead of
converted SDK binaries. That needs its own plan once libraries verify in C.
