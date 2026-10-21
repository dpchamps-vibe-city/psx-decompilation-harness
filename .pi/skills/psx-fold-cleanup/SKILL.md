---
name: psx-fold-cleanup
description: Make one folded library module read like the source its authors wrote, without changing a byte of the original object; module-only edits, re-verified by the refinement gate.
---

# Folded-module cleanup role

The supplied module is one original object's whole translation unit, folded
verbatim from its per-function parts. It already rebuilds the original object
byte for byte. Make it read like the source file its authors wrote, and keep
every byte of the object.

Edit **only the module file** named in the handoff. Every other edit is
restored after this turn and fails the cleanup. Do not commit.

## Clean

- **Fold debris.** Keep each `#include` once, near the top, unless a later
  position changes the object. Replace the split scaffolding comment (`Original
  TU: … Replace INCLUDE_ASM stubs …`) with a one-line note naming the original
  object.
- **Decompiler names.** Give locals, parameters and file-static helpers
  meaningful names (`temp_v0`, `var_a1`, `arg0`, `func_000001B8`). Never rename
  an external symbol: its name is part of the object and of other members' links.
- **Private helpers.** A `func_<offset>` helper is a static function that the
  object never named. Rename it everywhere it appears: prototype, definition
  and calls. Its prototype and definition must agree on `static`. `tu.json`
  keeps `func_<offset>` as the helper's target identity, and the harness finds
  the helper by its position. That is expected; leave `tu.json` alone.
- **Template headers and types.** Prefer the SDK's own headers (the project's
  reference headers) and their types over decompilation-template ones
  (`common.h` types, local `/* extern */` prototypes), where the object stays
  identical. Drop `include_asm.h` unless retained `INCLUDE_ASM` lines remain.
- **Private prototypes.** A declaration from the member's private header may
  move into the module as a file-local declaration; then stop including that
  header. The header file itself is outside this turn's scope.
- **Comments.** Short, factual notes on non-obvious hardware, protocol or SDK
  behavior. No speculation and no restatement of the code.

## Never change

- The order of definitions and declarations: it fixes code layout and the
  object's symbol IDs.
- External names, calling conventions, initializer bytes, storage classes,
  `const`, alignment or sizes.
- Retained hand-written functions: their `INCLUDE_ASM` lines stay exactly as
  they are.
- No new embedded assembly, asm labels, register pinning, flag overrides,
  `INCLUDE_ASM` lines or allowlist changes.

## Verify as you go

After each meaningful edit run `npm run library -- check --member <MEMBER>`;
it must report `VERDICT: MATCH`. If it does not, undo that edit. Keep edits
small enough to bisect.

Finish with a short reply listing what changed. If the module already reads
like original source, say so and change nothing. After your reply the harness
re-runs the source policy, every function's byte diff, and the member plus all
previously verified members. Any failure reverts the module to the verbatim
fold, and the cleanup resumes on a later run.
