# Relocatable library targets

The ELF/ar adapter supplies the same function/TU contract as the linked-image
adapter: source ownership, original assembly, INCLUDE_ASM, flags, coordinates and
verification scope. Existing tools and skills consume that contract; no alternate
agent workflow is needed. No EXE or artificial RAM layout is required.

## Configure and bootstrap

Copy `examples/library/project.json` to the repository root and change `$schema`
to `./tools/lib/project.schema.json`. Select the authoritative inputs and headers:

- `target.archives`: root-relative globs for ar archives of ELF objects.
- `target.standaloneObjects`: root-relative globs for individual ELF objects.
  Do not also select an archive's extracted member copies. Each glob must match;
  duplicate input paths are rejected. Original inputs must stay inside the
  project, outside `build/`.
- `headers.reference`: immutable reference directories, e.g. `include/psyq`.
- `headers.owned`: editable project declaration/type directories, e.g.
  `include/library`. They must not overlap reference directories. Create headers
  here as evidence warrants, not by copying the entire SDK declaration set.
- `headers.context`: selected **include spellings**, e.g. `libcd.h`, not directory
  paths. They are included in fresh scaffolds and m2c context; include the scalar
  aliases used by m2c (e.g. `common.h`). Select headers for the actual target; the example's CD header is not a universal library umbrella.
- `output.sourceDir`: directory under `src/`, default `src/libraries`.
- `selection.scope: "all-code-members"`: queue all identifiable code, including
  SDK-named functions; do not infer liveness or handwritten assembly. Data-only
  and unresolved-code members remain in inventory and final verification.
- `verification.mode: "relocatable-object"`: compare the original member, not a
  linked image at an invented address.

The current parser supports **ELF32 little-endian MIPS ET_REL**, standalone or in
ar. Original PSY-Q `.LIB`/LNK files need a conversion adapter first. Retain the
original hashes, converter/version and member mapping as provenance: a converted
object match is a claim about that object, not independently about its original
LNK encoding. Image SDK integration's `patchLibBss`/placement/signature machinery
is not run on library targets.

Keep compiler executables, candidate version, flags, defines and include search
paths in `toolchain.json`. This remains the cpp → cc1 → maspsx → GAS protocol;
config does not identify the historical compiler or implement a new driver.
Named profiles can replace any flag array and `includeDirs`. Omitted values
inherit base; supplied arrays replace rather than append. A project's
`toolchainProfile` selects its default profile; `memberProfiles` maps exact IDs
from inventory to profiles and wins over that default. Otherwise the toolchain's
exact-owner/kind (`library`) profile selection applies. Profiles share one
configured compiler executable/version; mixed compiler versions still need an
adapter. Per-TU `fileFlags` are keyed by **member ID**, require evidence and
human policy approval, and must not be changed by matching workers.

```sh
npm ci
npm run setup
npm run identify -- --json
npm run split-all
npm run profile -- --write
npm run progress
```

`identify` reports ELF sections, symbols, relocations and member provenance;
these do not prove the historical compiler/flags. `profile` generates the same
`configs/project-profile.md` consumed by the existing skills, including header
roles, toolchain choices, ownership, verification scope and available analyses.

## One original member, one translation unit

Inventory identifies members by input path and ordinal, not basename or address;
the original SHA-256 accompanies every measurement. Duplicate member names and
symbols are allowed. Moving/reordering inputs changes identity, so review config
and source mapping rather than silently migrating a TU.

`src/libraries/<member-id>/<member-name>.c` owns every function and global from
that member. `split-all` creates **INCLUDE_ASM stubs**, with reference assembly
under `build/libraries/nonmatchings/<member-id>/`. Unrecovered functions keep the
normal idiom:

```c
#include "include_asm.h"
INCLUDE_ASM("build/libraries/nonmatchings/MEMBER_ID", FunctionName);
```

Assembly-backed member data uses a separate `__library_member_data` include.
Replace it with real C definitions when recovering the complete TU; do not omit
its data/BSS/COMMON or count it as reconstructed C. Splitting regenerates assembly
but **never overwrites existing source**. There is no original-object fallback
that lets missing C pass verification, nor are empty C bodies valid scaffolds.

Use `MEMBER_ID::Symbol` from inventory as the target name. A bare symbol works
only when unique. Symbol bounds inferred from NOTYPE/size-zero labels are
explicitly marked; these are not proven function sizes. Invalid C symbol names,
alias boundaries or unsupported listings may need an adapter/manual review.

```sh
npx tsx tools/agent/m2cFunc.ts 'MEMBER_ID::Symbol'
npm run diff -- 'MEMBER_ID::Symbol'
npm run library -- diff 'MEMBER_ID::Symbol' --src build/YOUR-DRAFT.c
npm run library -- check --member MEMBER_ID
```

Pi's `psx_m2c`, diff/residual and finalization use the same backend. Preparation
works on the **whole member** with the selected context. Existing real C and
edited build drafts are preserved; raw m2c output/diagnostics are retained even
when generation or compilation fails. With multiple functions, integrate the TU
explicitly: automatic single-stub staging is refused to protect neighbors.
Untouched INCLUDE_ASM compiling is not proof that the m2c draft compiles.

## Oracle, gates and progress

Acceptance compares the **entire owning member**:

- allocated sections: type, flags, size, alignment, entry size and initialized
  bytes (including encoded relocation addends); NOBITS/BSS extents;
- architecture/ABI flags and linker-visible exports, imports and COMMON;
- symbolic relocation offsets, types and targets, preserving per-section order
  for MIPS HI16/LO16 pairing. Relocation fields are not masked away.

Debug/file/local-label naming is not program identity. Converted NOTYPE/size-zero
annotations are treated as unknown, not zero-length definitions. Unsupported
formats/relocations produce failure or `UNDETERMINED`, never `MATCH`.
INCLUDE_ASM or nonmatching markers produce `STUB`, even at 100% words. Strict
member checking additionally requires clean C, policy compliance and definitions
for the inventoried functions.

- `npm run build`: compile present member TUs; **not** a verification claim and
  not an archive-repacking task.
- `npm run check` / `npm run check-all` / unscoped `library check`: require
  **every configured member**, including data-only objects. Unrecovered stubs
  correctly fail this completion boundary.
- `library check --member ID` (repeatable): check those members plus every
  previously verified member. Pi finalization uses active/changed member scope
  plus this verified set and still enforces source/scope policy. It does not
  claim completion of the untouched backlog.
- `library check --accepted`: only recheck previously verified members; the
  loop's environment guard, **not** an active-target or completion gate.
- `npm run progress`: count functions/code bytes only in members with fresh
  whole-member verification records. Source presence, stub compilation and SDK
  names do not increase completion. Config, tool, target, header or source changes
  invalidate affected records until rechecked.

Library call graphs use member/symbol coordinates, never invented VRAM. Calls
are conservative unambiguous `R_MIPS_26` edges; unresolved relationships are not
liveness evidence. Parking retains the member TU unchanged, rather than restoring
one function's stub and discarding neighbors.

Context export uses fresh clean-C member verification and generates per-owner
m2c-only types/signatures under `build/libraries/context/`, avoiding duplicate/local
symbol collisions. Reference SDK headers are never rewritten. Preparation reuses
this context when present; finalization includes publication.

Compiler traces, staged residuals, schedule/allocation solvers, loop traces,
web partitions, callee checks, flag probes and source-shape searches use the
shared diagnostic paths. Compile the whole TU; function-local assembly/RTL views
are projections of that compile, with untouched TU artifacts retained alongside
them. Compiler interventions and their logs are scoped to the actual C symbol,
so repeated UIDs in neighboring functions cannot affect the experiment.

Instruction views retain symbolic relocations and section coordinates. Inferred
NOTYPE/size-zero extents remain explicitly uncertain. Function-local agreement,
or zero staged terms, cannot certify neighboring code/data or object layout:
residual reports retain the whole-member verdict and finalization checks the TU.
