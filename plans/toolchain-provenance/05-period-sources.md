# Phase 5 — Period sources

Status: proposed. Depends on: Phases 2, 3 and 4.

## Goal

Every member's assembler input is something the 1997 toolchain reads, written
the way Sony wrote it:

- C compiled by `cc1`;
- hand-written assembly in Sony's style;
- backlog stubs as plain disassembly, from which the assembler produces the
  relocations itself.

## Current state

- **625 assembly members** began as spimdisasm output for modern GNU as:
  - `$a0`-style register names;
  - `glabel`/`endlabel` from `include/macro.inc` (keyword macro arguments,
    `.internal`, `.type @function`);
  - GTE operations through the project's `gte_macros.inc`, which encodes COP2
    directly.

  The 1997 assembler reads 17 of them.
- **Every C translation unit** gets `.include "include/macro.inc"` from
  `include/include_asm.h`.
- **Backlog stubs** (`tools/lib/libraryAssembly.ts`) rebuild the target from:
  - raw `.word` encodings;
  - immediates copied from the target;
  - `.reloc` copies of the original relocation table;
  - section flags, tail bytes and exports copied from the target.

  1,381 members depend on stubs.
- The include files are canonical in the harness `include/`.
  `tools/build/scaffoldProject.ts` copies them into a project at bootstrap.

## Sony's style, from the HMD sources

- Sources are `.ASM` files run through cpp.
- `#include <r3000.h>`, `<asm.h>`, `<inline_s.h>`, `<gtereg_s.h>`.
  - `asm.h` defines register names (`a0` = `$4`).
  - `inline_s.h` defines GTE macros (`RTPT`, `NCLIP`, …) that emit DMPSX
    placeholders.
- `/* */` comments, `.globl`, `.text`, `.set noreorder` regions, plain labels.

## Work

### Harness (checked in here)

- **Assembly TU route** (`tools/agent/decompToolchain.ts`,
  `tools/lib/libraryTranslationUnit.ts`): a Sony-style source goes through
  production cpp (Phase 2) with the project's include directories, then `as`,
  then the declared stages (Phase 4).
  - Extension: `.ASM`, as Sony's sources use (decision D5).
  - The existing `.s` route stays for projects that don't opt in.
- **Stub generator** (`tools/lib/libraryAssembly.ts`), rewritten to emit period
  syntax:
  - real instructions with symbolic operands (`%hi`/`%lo`, labels, externals),
    so the assembler produces the relocations;
  - no `.word` encodings of instructions;
  - no `.reloc`;
  - no copied section flags or synthesized exports;
  - GTE operations as SDK macros; registers via `asm.h` names;
  - data as `.word sym`/`.byte`.

  Whatever cannot be expressed this way is a reported generator gap, not a
  fallback to copied bytes.
- **Source policy** (`inspectAssemblyPart`): also reject raw `.word`
  instruction encodings in executable sections of hand-written assembly. This
  is an audit gap.
- **Period scaffold templates:** a `macro.inc` 1997 GNU as can read (positional
  macro arguments; no `.type`/`.size`/`.internal`) and an `include_asm.h` that
  includes it only where `INCLUDE_ASM` stubs need it. Bootstrap offers them when
  a project selects the ECOFF assembler. The modern templates stay the default.
- **Tests, synthetic:**
  - Sony-style source through cpp → as → stage;
  - stub generator output for synthetic objects round-trips to identical
    objects;
  - the policy rejects raw instruction words.
- **Docs:** `docs/library-targets.md` (assembly TUs, stubs) and
  `docs/bootstrap.md` (period templates).

### psyq-decomp (checked in there)

- `include/`: period `macro.inc` and `include_asm.h`. GTE headers move to the
  SDK's `inline_s.h` plus the stage, unless the Phase 4 audit decides
  otherwise.
- **625 assembly TUs converted to Sony style:**
  - `#include <asm.h>`/`<inline_s.h>`;
  - `a0` register names;
  - SDK GTE macros;
  - `/* */` comments.

  The converter is a one-off, run once, kept under local `build/` and not
  checked in. Each converted file is accepted only if its member is exact
  against the LNK original under the full period pipeline. Expect a few real
  investigations: 5 of the 625 didn't match even under 2.9.1.
- Any `.s` content the conversion reveals as copied target bytes is listed in
  the research note.

### Local only

- Regenerated backlog stubs (`build/libraries/nonmatchings/…`).
- The one-off converter and its per-file results.

## Acceptance

- All 2,167 members assemble under the period pipeline.
- Each of the 625 converted members is exact against its original.
- **Stub round trip:** building every member from stubs alone reproduces its
  original exactly. This proves the generator copies nothing it shouldn't need.
- No raw instruction `.word`s remain in hand-written assembly.

## Risks

- **spimdisasm output that can't be expressed symbolically,** such as
  ambiguous relocation targets or data/code overlap. Report each case; a narrow
  generator fix is fine, falling back to copied bytes is not.
- **Converted sources match only because of a different macro expansion than
  Sony's.** The HMD validation in Phase 4 anchors the macros; keep the SDK
  headers unmodified.
