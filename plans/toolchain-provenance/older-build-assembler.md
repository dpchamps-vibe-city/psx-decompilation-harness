# Older builds' assembler

This task is separate from the migration (`completion-plan.md`). It runs while
the autoloop runs, and the migration doesn't wait for it.

## Goal

Return `LIBGUN.LIB` (`GUN.OBJ`, `NEWGUN.OBJ`) and `LIBTAP.LIB` (`TAP.OBJ`) to
psyq-decomp's selection. They were dropped on 2026-10-18 because no assembler
we have reproduces them.

For each of the three:

```
sha256(rebuilt .OBJ) == sha256(original .OBJ)
```

## What is known

Evidence: `../psyq-decomp/build/toolchain-provenance/fix-research/early/`
(git-ignored). Its README lists the scripts.

Sony archived the three on 1997-09-22. Every other selected member was archived
2000-02-16, except `POWERON.OBJ`, which is dated 1995-03-23.

**The assembler**

- In 7 places outside delay slots (GUN 5, NEWGUN 1, TAP 1), the originals list
  relocations in an order that contradicts their byte order. None of the 2,163
  standard members has any (`inversions.mts`).
- GNU as writes every non-`%hi` relocation in source order. It moves an
  instruction only to fill a jump's delay slot, so no GNU as source produces
  these orders.
  - binutils 2.6, 2.7, 2.8, 2.8.1 and 2.9.1 and the 1996–97 trunk snapshots all
    give the same order (`multi.mts`).
- The orders are what an assembler that schedules instructions after expanding
  macros writes.
  - At NEWGUN 0x204–0x21c, the relocations follow the program order
    `lw x; addi; sw x; lw y`, while the bytes put `lui $1` ahead of `addi`.
- That fits the MIPS vendor assembler, which cc1's `-mmips-as` option targets.

**The packaging**

The three have the `early` layout that POWERON witnesses: the second section
header, and no SWITCH for empty sections. They also show:

- **A lone REFLO.** A REFLO with no REFHI of its own takes the low half of the
  previous REFLO's word as the high half of its addend.
  - This holds at 11 of 11 sites (GUN 7, TAP 4).
  - Standard originals follow `psyq-lnk`'s rule at 78 of 78 sites.
- **A jump to a global defined in the same object.** It has a zero jump field in
  BYTES, with `sectbase(.text) + target` in the patch.
  - This holds at 3 of 3 sites, all in GUN.
  - Standard originals keep the field equal to the target in all 226 such calls.
  - It comes from the assembler keeping the relocation against the global.
- **`.sbss`.** Small uninitialised data is in `.sbss`, and these three are the
  only members that use it.
  - With the period `as` at `-G8`, consecutive 8-byte `.lcomm` pieces with `$L`
    names reproduce the section and every patch into it.

Apply all of this to their stubs: the symbol part, the two rules above and the
`.sbss` pieces. The rebuilt and original objects then hold the same records.
They differ only in relocation order, and in the lone-REFLO addends that depend
on it.

## Steps

1. Obtain the MIPS vendor assembler, in a build that writes little-endian
   ECOFF.
2. Install it as a pinned tool with a recipe, the way the period `as` is
   installed (`../psyq-decomp/tools/binutils-recipes/gas-19970318-psx/`).
3. Return `LIBGUN.LIB` and `LIBTAP.LIB` to `project.json`, with the new
   assembler as the `sony-early` profile's `as`.
4. Generate the three members' stubs, and run `check --member` for each.
5. Add each packaging rule above to the `early` layout only when it makes one of
   the three identical. Record the rule's evidence in
   `../psyq-decomp/configs/toolchain-identification.md`.
6. Record the identification in `../psyq-decomp/notes/research/`, following
   `assembler-identification-methodology.md`.
7. Run `npm run check-all`.

## Done when

- GUN, NEWGUN and TAP rebuild identical through the pinned assembler,
  `psyq-dmpsx`, and `psyq-lnk` with the `early` layout.
- POWERON still rebuilds identical.
- `LIBGUN.LIB` and `LIBTAP.LIB` are in the selection, and `npm run check-all`
  passes.

## Rules

The migration plan's rules apply:

- no masking or per-member exceptions in the check;
- a converter rule only with an original it makes byte-identical;
- no commits without the user's go-ahead.
