# Relocatable library targets

The ELF/ar adapter supplies the same function/TU contract as the linked-image
adapter: source ownership, original assembly, INCLUDE_ASM, flags, coordinates and
verification scope. Existing tools and skills consume that contract; no alternate
agent workflow is needed. No EXE or artificial RAM layout is required.

## Configure and bootstrap

After `pi install --local`, run `/skill:psx-bootstrap-project library` to create
the project source scaffold, empty input directories and `project.json`.
See [bootstrap](bootstrap.md) for the required inputs and safe re-run behavior.
Alternatively, copy `examples/library/project.json` to a cloned harness root and
change `$schema` to `./tools/lib/project.schema.json`. Select the authoritative
inputs and headers:

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
- `output.sourceLayout: "tu-directory"`: the library scaffold's recommended
  organization. Input directories (or archive stem/ordinal) name a TU directory;
  each function owns one `.c` file, with ordered shared declarations/data and a
  `tu.json` manifest. `grouped` and `member-id` retain legacy monolithic files.
- `output.inputRoot`: stable root for deriving those directory names; set it
  explicitly when expanding input selection.
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
paths in `toolchain.json`. On a case-sensitive host, DOS-uppercase SDK filenames
can break the headers' own lowercase includes. Use a provenance-checked,
case-normalized reference tree; do not repair immutable originals or let host
Linux headers satisfy SDK includes. With a self-contained SDK, `flags.cpp`
should include `-nostdinc`; verify the complete reference-header set below.
This remains cpp → cc1 → configured assembler
(MASPSX → GAS, or direct GAS with named compatibility rewrites);
config does not identify the historical compiler or implement a new driver.
Named profiles can replace any flag array, `assembler` and `includeDirs`. Omitted values
inherit base; supplied arrays replace rather than append. A project's
`toolchainProfile` selects its default profile; `memberProfiles` maps exact IDs
from inventory to profiles and wins over that default. Otherwise the toolchain's
exact-owner/kind (`library`) profile selection applies. Profiles share one
configured compiler executable/version; mixed compiler versions still need an
adapter. Per-TU overrides live in `configs/flag_overrides.mk`, require evidence
and human policy approval, and must not be changed by matching workers. The JSON
`fileFlags` channel is not supported.

```sh
npm ci
npm run setup
npm run identify -- --json
npm run split-all
npm run profile -- --write
npm run progress
```

Choose a member's assembler from `identify`'s original-word indexed-load census
and, when native LNK libraries are supplied, its packaging signatures. A target
may mix ASPSX-built and GNU-built members: use an explicit member profile, not a
single SDK-wide assumption. The configured backend alone is the acceptance
path; alternatives are diagnostic. Selection changes invalidate verification
identities and require rechecking the affected members. See
[assembler backends](toolchain.md#assembler-backends) for rewrite, `-G0` and
reorder-mode restrictions.

`identify` reports ELF sections, symbols, relocations and member provenance;
these do not prove the historical compiler/flags. `profile` generates the same
`configs/project-profile.md` consumed by the existing skills, including header
roles, toolchain choices, ownership, verification scope and available analyses.

## One original member, one translation unit

Inventory identifies members by input path and ordinal, not basename or address;
the original SHA-256 accompanies every measurement. Duplicate member names and
symbols are allowed. Moving/reordering inputs changes identity, so review config
and source mapping rather than silently migrating a TU.

With `tu-directory`, a standalone `input/libapi/counter.o` becomes:

```text
src/libraries/libapi/counter/
  tu.json                ordered parts, original member identity; no flags
  _shared-0.h            shared includes/types/declarations
  SetRCnt.c              just SetRCnt, or its sole backlog stub
  GetRCnt.c              just GetRCnt, or its sole backlog stub
  ...
  _data.c                shared C data, or its separate backlog stub
```

Case-distinct names receive ordinal prefixes when needed. Additional shared
fragments preserve declarations interleaved with functions in the original
source. The production preprocessor receives a generated ordered include driver
under `build/`: **one GCC translation unit**, with the same private globals,
prototype scope, function order and per-member flags. Every experiment replaces
only its selected function include in that same driver. There is no isolated
compile, post-match stitching or second acceptance environment.

Private entries can also be witnessed by section-relative `R_MIPS_26` JAL
relocations. Discovery rejects interior sized symbols, fallthrough and
cross-boundary shared blocks; raw J fields and imports are not boundaries.
These bounds remain **inferred**, not recovered historical sizes. The adapter
feeds original section/file coordinates and bounds to the disassembler before
call discovery, avoiding ET_REL addends being mistaken for listing addresses.
Complete original code words and boundaries are validated before publishing.
Private helper names retain the established local listing spelling so already
matched callers do not acquire fictitious imports; authoritative coordinates
remain member/section/offset, never those numeric names as runtime addresses.

`split-all` conservatively migrates legacy sources after batch AST preflight.
It preserves function bodies and declaration order, refuses conflicting copies,
local-header ambiguities and conditional/location-dependent splits, and never
chooses between edits. Existing directory TUs are not overwritten. Newly witnessed private entries
may extend a directory manifest only by subdividing exclusive canonical
original-assembly backlog. Existing C, declarations, data and function filenames
are preserved; a real-C owner or conflicting files require review. Disassembly
and source preflights run before publishing the batch. The
`grouped`/`member-id` modes remain whole-member C files.

Reference assembly stays under `build/libraries/nonmatchings/<member-id>/`.
Unrecovered function files keep the normal idiom:

```c
#include "include_asm.h"
INCLUDE_ASM("build/libraries/nonmatchings/MEMBER_ID", FunctionName);
```

Assembly-backed member data uses a separate `__library_member_data` include.
Replace it with real C definitions in its own data fragment; do not omit its
private binding, data/BSS/COMMON or count it as reconstructed C. Reference
scaffolds retain original private bindings; diagnostic nonmatching markers are
local, so neither manufactures exports or changes encoded relocation addends. Splitting regenerates assembly
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

Pi's `psx_m2c`, diff/residual and finalization use the same backend. In directory
TUs preparation drafts **only the selected function**, using the actual owner
scope, and measures it in the normal whole-TU compile. The handoff explicitly
separates this single-function assignment from the whole-member oracle: neighbors
and shared storage are context, not additional decompilation assignments. Mutable
initializers remain in the data fragment rather than being emitted in the draft.
Existing real C and edited build drafts are preserved; raw m2c output/diagnostics
survive failure. Automatic staging accepts generated C, including approved
SDK-typed platform-macro bindings, but may replace only an unchanged, committed
exclusive function stub. A fresh, exact prepared result is staged and finalized
through the normal whole-TU route before any matching-model dispatch, including
prep-led ladders. Refreshed prep results receive the same shortcut. Source policy,
scope, whole-member verification and context publication still have to pass;
failed staging/finalization falls back to the agent without discarding live work.
Static completions retain their packet/evidence and mark model documentation
`skipped`, not `passed` or pending: no notes turn delays the next function.
Agent-authored matches retain the configured notes workflow. Legacy monolithic
multi-function TUs still require explicit integration. Untouched INCLUDE_ASM
compiling is never proof that a draft compiles.

## End-to-end onboarding check

Before model dispatch, test a **real mixed member** with private callees/data,
not just a tiny leaf or synthetic compiler smoke test:

```sh
npm run split-all
npm run library -- check-splits
npm run library -- preflight 'MEMBER_ID::Symbol'
npm run check-all
```

`check-splits` compiles every published original assembly fragment in generated
reference scaffolds under the configured per-member production toolchain and
runs the unchanged whole-member byte/symbol/relocation oracle. It does **not**
compile or certify live reconstructed C and writes no acceptance records.
`preflight` preprocesses all configured SDK reference headers, validates the
ordered TU contract, compiles the actual owning TU, checks the whole member,
and freshly exercises selected-function m2c preparation without promoting
source or relying on an earlier cached draft. Reports live in
`build/libraryPreflight/`; failures return nonzero. Draft generation,
compilation and comparison are separate reported claims: setup can pass while
an unknown-type draft still needs preparation. Only `check-all`/normal
finalization certifies live C. A split-fidelity pass cannot hide a failing C
attempt, and none of these setup checks establishes C completion.

The synthetic regression exercises the same production route with a size-zero
export, relocation-only private helper, seven-word BIOS veneer, neighboring
data and DOS-cased headers; negative controls cover header casing and differing
neighbor data. Private BIOS veneers are classified from original words, not
queued as ordinary C or granted new assembly-policy exceptions.

## Oracle, gates and progress

Acceptance compares the **entire owning member**:

- nonempty allocated program sections: code/data and initialized/zero-fill
  storage kind, size and exact initialized bytes (including encoded relocation
  addends); NOBITS/BSS extents;
- linker-visible exports, imports and COMMON, including binding, visibility,
  section and value; known original type/size annotations remain constraints;
- symbolic relocation offsets, types and targets. Complete, independent MIPS
  HI16(s)+LO16 groups may differ in table placement, but each group's internal
  ordering and pairing remain exact. Overlapping fixups, mixed-symbol pending
  groups and dangling HIs retain strict table order. Individual HI/LO entries
  are never sorted independently; relocation fields are never masked away.

This is program-content identity, not identical ELF packaging. ELF header flags,
section alignment/entry sizes, empty sections and nonexecutable assembler ABI
bookkeeping are excluded. Debug/file/local-label naming is not program identity. Converted NOTYPE/size-zero
annotations are treated as unknown, not zero-length definitions. Unsupported
formats/relocations produce failure or `UNDETERMINED`, never `MATCH`.
A selected function's INCLUDE_ASM/nonmatching marker produces `STUB`, even at
100% words. Directory builds allow **exclusive original backlog files**, not
mixed C/assembly files: each function fragment is one definition or its sole
canonical placeholder; shared fragments cannot hide functions. Clean fragments
must pass source policy. The entire object's bytes, relocation addends, symbol
population and neighboring storage are still checked without masks or partial
object exemptions. Legacy monolithic member checking still requires complete C.

- `npm run build`: compile present member TUs; **not** a verification claim and
  not an archive-repacking task.
- `npm run check` / `npm run check-all` / unscoped `library check`: require
  **every configured member**, including data-only objects. Directory backlog
  can be byte-exact, just as an image project's original stubs can; this is a
  build identity claim, never a decompilation-completion claim.
- `library check --member ID` (repeatable): check those members plus every
  previously verified member. Pi finalization uses active/changed member scope
  plus this verified set and still enforces source/scope policy. It does not
  claim completion of the untouched backlog.
- `library check --accepted`: only recheck previously verified members; the
  loop's environment guard, **not** an active-target or completion gate.
- `npm run progress`: distinguish byte-verified members from reconstructed TUs.
  A function counts only when its own file is clean C and its owning member has
  fresh whole-member verification. Neighboring stubs never count as completed.
  Code-byte completion requires a fully reconstructed member. Config, tool,
  target, header or source changes invalidate affected records until rechecked.

Library call graphs use member/symbol coordinates, never invented VRAM. Calls
are conservative unambiguous `R_MIPS_26` edges; unresolved relationships are not
liveness evidence. Parking retains the member TU unchanged, rather than restoring
one function's stub and discarding neighbors.

Context export uses fresh whole-member verification, publishes only reconstructed
functions (not backlog neighbors), and generates per-owner
m2c-only types/signatures under `build/libraries/context/`, avoiding duplicate/local
symbol collisions. Reference SDK headers are never rewritten. Preparation reuses
this context when present; finalization includes publication.

Compiler traces, staged residuals, schedule/allocation solvers, loop traces,
web partitions, callee checks, flag probes and source-shape searches use the
shared diagnostic paths, subject to the configured provider's validated support. Compile the whole TU; function-local assembly/RTL views
are projections of that compile, with untouched TU artifacts retained alongside
them. Compiler interventions and their logs are scoped to the actual C symbol,
so repeated UIDs in neighboring functions cannot affect the experiment.

Instruction views retain symbolic relocations and section coordinates. Inferred
NOTYPE/size-zero extents remain explicitly uncertain. Function-local agreement,
or zero staged terms, cannot certify neighboring code/data or object layout:
residual reports retain the whole-member verdict and finalization checks the TU.

Preparation includes the experiment ledger and configured diagnostic availability.
A `build/` draft is explicitly not integrated; source existence, compilation,
exactness and finalization remain separate claims. See [diagnostic providers](toolchain.md#configured-diagnostic-providers).

`tools/build/deriveTuOwnedGlobals.ts MEMBER::Symbol` reports the original member's
allocated non-executable definitions and COMMON storage, plus symbolic GPREL
references in the selected function. Private bindings and section offsets remain
explicit; zero-size extents stay unknown. It generates no C and does not infer
ownership of imports from GP accesses.

Two larger adapters remain outstanding: family-transfer indexing/substitution
still uses linked-address holes and image/source ownership; automatic library
reconstruction supports only its existing call-free, non-symbolic domain.
Symbolic storage/callee execution needs an address/memory domain extension, not a
compiler-version workaround. Neither limitation permits invented RAM addresses,
masked relocations, isolated matching or a weaker whole-member oracle.
