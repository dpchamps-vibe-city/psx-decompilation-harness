# Relocatable library targets

The Sony LIB/LNK and ELF/ar adapter supplies the same function/TU contract as the linked-image
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

- `target.archives`: root-relative globs for Sony LIB archives (`psyq-lib`) or
  ar archives of ELF objects (`elf-ar`).
- `target.standaloneObjects`: root-relative globs for Sony OBJ or ELF objects.
  Do not also select an archive's extracted member copies. Each glob must match;
  duplicate input paths are rejected. Original inputs must stay inside the
  project, outside `build/`.
- `headers.reference`: immutable reference directories, e.g. `include/psyq`.
  Production include flags point to a content-addressed LF-only copy under
  `build/headers/reference/`; the SDK inputs are never rewritten or vendored
  into owned includes to work around CRLF continuations.
- `headers.owned`: editable project declaration/type directories, e.g.
  `include/library`. They must not overlap reference directories. Create headers
  here as evidence warrants, not by copying the entire SDK declaration set.
- `headers.context`: selected **include spellings**, e.g. `libcd.h`, not directory
  paths. They are included in fresh scaffolds and m2c context; include the scalar
  aliases used by m2c (e.g. `common.h`). Select headers for the actual target; the example's CD header is not a universal library umbrella.
- `headers.requires`: reference headers, by include spelling, that rely on their
  includer having included others first, e.g. `"libgs.h": ["sys/types.h",
  "libgte.h", "libgpu.h"]`. Preparation adds the reference headers that declare
  the target, the member's imports and the types its constraints carry (see
  below), each after the headers it requires.
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

Two inventories are supported: `target.format: "elf-ar"` selects ELF32
little-endian MIPS ET_REL objects/archives; `"psyq-lib"` selects original PSY-Q
LIB archives and standalone LNK v2 objects. Never select a converted object as
both an acceptance target and an original-object view.

### Original-object verification

`verification.mode: "original-object"` requires
`sha256(rebuilt .OBJ) == sha256(original .OBJ)`. The production chain assembles
ECOFF, optionally finalizes GTE commands with `psyq-dmpsx`, then writes Sony
LNK v2 through the final `psyq-lnk` stage. The converter never opens an original.
Its `lnkLayout` is `standard` (default) or the original-witnessed `early` layout;
see [toolchain configuration](toolchain.md#assembler-backends).

The hash covers every byte, including record order, IDs, empty sections and
encoded addends. Mismatches print the first differing .OBJ record. Accepted
records store both hashes and the executed tool pins, implementation hashes and
layout receipts. Cross-format/relocation equivalence is diagnostic only and
cannot accept a member. LNK expressions retain their right-first wire order
and complete semantic tree in diagnostic readers.

For a transitional `elf-ar` inventory, configure
`verification.originals: { format: "psyq-lnk", archives: [...], objects: [...],
map: { MEMBER_ID: { archive: "inputs/runtime.LIB", ordinal: 0 } } }` (or
`{ object: "inputs/start.OBJ" }`). Every member needs a unique, content-checked
pairing. The converted view must agree in storage, unrelocated bytes, relocation
sites/kinds/targets and external identities. This correspondence check is input
validation only; it never supplies acceptance bytes.

For `psyq-lib`, the originals are the inventory, so remove the transitional
mapping. IDs are lowercase `<archive-stem>_<ordinal>` and standalone object
stems; collisions are errors. `views.elf: { MEMBER_ID: "views/member.o" }`
is mandatory for disassembly/m2c and is content-checked. Keep `output.inputRoot`
pointing at the view tree to preserve TU directories.

`npm run library -- migrate-member-ids [--json]` dry-runs the complete mechanical
migration from a transitional inventory. `--write` builds every member before
and after the rename and requires the same per-member result, including known
mismatches. A build failure or changed result rolls the transaction back. It
rewrites project files and owned autoloop state/attempt paths, changes the
inventory/configuration together, and invalidates disposable build products. Unknown old IDs, collisions, unsafe paths and unmapped
members fail before writes. Stop workers first; re-run `check-all` before resuming
them. There is no second runtime identity scheme or implicit historical alias.

Keep compiler executables, candidate version, flags, defines and include search
paths in `toolchain.json`. On a case-sensitive host, DOS-uppercase SDK filenames
can break the headers' own lowercase includes. Use a provenance-checked,
case-normalized reference tree; do not repair immutable originals or let host
Linux headers satisfy SDK includes. With a self-contained SDK, `flags.cpp`
should include `-nostdinc`; verify the complete reference-header set below.
This remains cpp → cc1 → configured assembler
(MASPSX → GAS, or direct GAS with unchanged input and explicitly declared stages);
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
[assembler backends](toolchain.md#assembler-backends) for provenance, `-G0` and
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

A member whose functions own switch tables also gets `_rodata-N.c`, the
.rdata in front of the Nth table, placed before the table's owner (see
[switch tables](#switch-tables-in-c-members)).

Case-distinct names receive ordinal prefixes when needed. Additional shared
fragments preserve declarations interleaved with functions in the original
source.

Existing assembly-origin sources (GTE drivers, BIOS hooks, card/pad patches)
can be represented as **one `.s` or cpp-preprocessed `.ASM` source**, listed as
the manifest's only part with every original function it defines. This is not
permission for a C worker to reconstruct or repair assembly, translate compiler
output into source, or fit source spellings to a target:

```json
{ "schemaVersion": 1, "member": "MEMBER_ID",
  "parts": [{ "path": "rotsmd.s", "symbols": ["RotSMD_F3", "RotSMD_G3"] }] }
```

An assembly TU has no C neighbors and no data stub: the file carries its own
`.data`/`.bss`/`.comm` storage. It is assembled by the configured production
assembler for that member, without rewriting assembler input. A `.ASM` source
first runs through production cpp with assembly-language defines and the configured
include directories; it bypasses cc1, then uses the same assembler and declared
stages as C. Plain `.s` remains assembler-only. The part must
be reconstructed source, not a listing: disassembler backlog markers, `.reloc`
tables, `.incbin`, raw instruction words in executable storage and path includes
are rejected before assembly, and every
listed symbol must be defined. Both the original `.ASM` (including local defines)
and its cpp expansion are audited, so included headers cannot hide raw encodings.
Executable data directives, including symbolic words and invalid instruction
encodings, are forbidden. Only known DMPSX placeholders (with the stage declared),
printable `.ascii`/`.asciz` text and zero-filled `.space` are permitted. Private (discovered) entries are listed by their
established local names. C candidates do not apply, and `prepare`/context export report the member as assembly. Verified
records carry `form: "assembly"`; progress and the call graph count these
functions separately from clean C (`sourceForm`), and the C loop's picker never
selects them. Comments can be annotated freely; in original-object mode, label
birth order can affect symbol IDs and must still pass the hash check. See the
process in [handwritten-assembly.md](handwritten-assembly.md#retaining-classified-handwritten-assembly).

ID migration walks the configured autoloop runtime directory as well as project
files; it refuses an active/stale `active.json` lock, symlinks, unmapped IDs and
file/directory collisions. The generated project profile is regenerated, not
text-patched, inside the transaction; failures restore source/profile bytes and
renamed paths. Library outputs/receipts, preparation packets and the old call
graph are invalidated. Run `split` to regenerate fragments/graph, then `check-all`
under the new IDs before resuming. The loop creates its lock while running and removes
it on shutdown. Stop it before migration; do not remove a live loop's lock.

Reference stubs are original-derived extraction artifacts, never reconstructed
source or compiler-output repairs. Listings normally stay under `build/`.
An explicit `retain-handwritten --write` retains the assembler-ready extraction
for already-classified native assembly TUs as described below. ECOFF
extraction preserves symbolic patch operands; no `.reloc` tables, tail repairs
or synthetic storage exports are emitted. SDK register/GTE operations are
preprocessed with receipts binding source/header hashes, flags and cpp. Ordinary
spimdisasm instructions are not decoded and re-rendered by another instruction
writer; literal words in generated listings are not subject to source audits.

The generated `__library_member_symbols` part comes first: original XDEF/XREF/XBSS
names in wire-ID order, with local `__lnk_hidden_<id>` labels for omitted IDs.
IDs start after cc1's two markers in a C TU, or at 1 in an assembly TU. All other
generated labels use `$L…`, except names referenced by existing TU parts.
Original patch order can witness assembler-filled delay slots; only those
extracted regions are emitted in reorder-mode source order. Unpatched data
words remain numeric; a patched word keeps its symbolic operand. OR moves are
spelled OR rather than the ADDU-producing `move` pseudo. These rules operate
only on extraction, never on reconstructed source or production compiler output.

An assembly backlog tracks just the generated `.include`s and any disabled
attempt, with `backlog: true`. C backlogs use one-line INCLUDE_ASM parts,
including the symbol part. Neither form emits `.NON_MATCHING` symbols. Every
generated part prevents TU completion. The generated parts become member-finishing
autoloop targets: `MEMBER::__library_member_data` and each `MEMBER::__library_member_rodata_N`
once every function part is C or retained (data-only members at once), then
`MEMBER::__library_member_symbols` once all the data is C too. Their preparation skips the function diagnostics: the data
draft is m2c's global definitions over the member listing, headed by each original
object's section, size and linkage; the symbol-order draft is a comment, so the
member must reproduce its LNK symbol IDs from the C itself, and the packet carries
the original-versus-rebuilt symbol order. The whole member's hash is the oracle. `check-splits`
checks fresh extraction in an isolated diagnostic directory, not existing stubs.
Unknown extraction cases fail closed; they do not authorize source rewriting.

#### Switch tables in C members

cc1 writes .rdata in TU order: a function's string literals while it is
expanded, its switch tables (`.align 3`, one word per case) while its code is
output. In the original object a table therefore sits between the strings of
the functions around it. A data part placed after every function could only put
a compiled table in front of all of the member's .rdata, and would still carry
the original copy.

Extraction finds each table from the original object: a run of `.rdata` words
holding code addresses inside one function that the function itself loads with
a HI16/LO16 pair. Such a table is extracted with its owner's code, in the
owner's `.s`, exactly where cc1 puts it. The .rdata before each table becomes
the generated part `__library_member_rodata_N` (`_rodata-N.c`). It sits in front
of the owner, and after the previous table's owner, so a C owner's own table
lands at the original offset. The .rdata after the last table stays in
`__library_member_data`. References into .rdata are written against the
nearest label in the referenced region, so each region keeps working when
another becomes C. `split` adds the missing `_rodata-N.c` parts to a TU whose
`_data.c` is still extraction, and a production build of such a TU without
them fails and asks for `split`. The manifest is validated: a rodata part must
name one of the member's segments, use its own path, and stay between its two
owners. A layout cc1 cannot produce, such as strings between two tables of one
function or tables out of function order, is not cut. Its tables stay in
`__library_member_data`, and their owners cannot match until it is reviewed.

### Retained handwritten extraction

`npm run library -- retain-handwritten [--write] [--json]` previews or retains
already-classified assembly-backlog members. It copies the existing unpreprocessed
assembly inputs **byte-for-byte** to `handwritten.ASM` and
`handwritten-symbols.ASM` beside the TU manifest. A generated CPP include driver
under `build/` puts declarations first, then production CPP produces `.s` under
`build/`. The assembler and declared stages are unchanged. No instructions,
labels or data are rewritten, and preprocessed `.s` files are not retained in
source. Existing source files and disabled attempts are preserved; only a bare
obsolete backlog wrapper is removed.

The assembly part carries `handwritten: { kind: "original-extraction",
format: "assembler-with-cpp", originalSha256,
declarations: { path, sha256 }, assembly: { path, sha256 } }`.
Its hashes bind both retained files to that native original. Inspection rejects
edited files, escaped paths and redirected includes; ordinary splitting preserves
the retained representation. The C loop still excludes every assembly TU and
its graph marks retained functions with `retainedHandwrittenAssembly: true`.
The extraction remains `backlog: true` to avoid claiming recovered author source
or reconstructed C. That status is not a request for an agent to rewrite it.

### Folded modules

Once every part of a C TU is final (real C, or a retained hand-written function)
and no generated part is extraction, the TU can fold into **one module per
original object**: `npm run library -- fold [--member ID ... | --all-ready]
[--write] [--json]`. The module joins the parts verbatim in manifest order, the
exact inverse of the per-function split; generated parts reduced to comments drop
out, and retained functions stay their canonical INCLUDE_ASM lines. It is named
after the original object (`QSORT.OBJ` → `qsort.c`) and its manifest has one part:
`{ "path": "qsort.c", "symbols": [...], "retainedFunctions": { ... } }`. The
module must define exactly its non-retained functions and is the TU's only part.

The default is a check: the module is staged under `build/libraries/fold/<id>/`
and built through the production chain, and it must reproduce the original object
hash. `--write` then replaces the parts, re-verifies the member and restores every
file on any failure; `build/libraries/fold-migration.json` records each fold.
Folded functions stay decompiled. Parking, preparation and private-entry
extension refuse a folded module, `split` leaves it alone, and the source policy
exempts only its retained INCLUDE_ASM lines. With the loop option `"autoFold":
true`, the autoloop folds a member as soon as its last target matches and commits
the fold under `fold <member>` when `commitOnMatch` is set (harness default off).

A library project has no per-match documentation role. That role records which
original translation unit a function belongs to (`notes/file-groupings.md`), and
a library member's object already names its unit, so the loop skips the turn
and records the match's documentation as `skipped`, whatever
`updateFileGroupings` says. Linked-image projects keep the role unless that
option is `false`.

A fold is followed by a **cleanup role**, built like the documentation role
for linked images: a cleared conversation, the documentation tools and the
`psx-fold-cleanup` skill. It makes the module read like its authors' source
(fold debris, decompiler names, template headers and types, comments) without
changing a byte of the object. Every function the object names keeps its name.
A private helper the object never named (`func_<offset>`, found by a call or
address relocation) may be renamed: its target identity in `tu.json` stays the
offset name, and the per-function diff finds it in the candidate at the same
code offset. It may edit only the module; anything else it
touches is restored and fails the cleanup. A cleanup is kept only when the
module is still a valid fold and the refinement gate passes: source policy,
every function's byte diff, and the member plus every previously verified
member byte-exact. The manifest then records `cleanedSha256`, the module text
that passed. A failed cleanup leaves the verbatim fold in place. A folded module
without a current marker (including one folded by hand) is pending cleanup, and
the loop takes it ahead of new targets and commits it as `clean <member>`.

For C members, the production preprocessor receives a generated ordered include driver
under `build/`: **one GCC translation unit**, with the same private globals,
prototype scope, function order and per-member flags. Every experiment replaces
only its selected function include in that same driver. There is no isolated
compile, post-match stitching or second acceptance environment.

Private entries can also be witnessed by section-relative `R_MIPS_26` JAL
relocations or published code addresses formed by original `HI16/LO16` pairs.
Address discovery preserves relocation-table pairing, symbol values and signed-low
carry, requires an unclobbered `LUI`/`ADDIU` chain and a pointer store/argument/
return/indirect-call use (including stores in delay slots), and validates the
candidate's independent control flow. Text loads, indexed switch addresses,
literals, unresolved computed jumps, fallthrough, cross-boundary shared blocks
and interiors of explicitly sized original symbols are not new functions. Raw
fields and imports are never entry witnesses. Other address forms, including
`R_MIPS_32`-only tables, are not promoted by this bounded recognizer.
These bounds remain **inferred**, not recovered historical sizes. The adapter
feeds original section/file coordinates and bounds to the disassembler before
call discovery, avoiding ET_REL addends being mistaken for listing addresses.
Complete original code words and boundaries are validated before publishing.
The original entry census is rechecked before inferred bounds are passed to the
disassembler: byte-exact reassembly alone cannot certify a one-function partition,
because a compound assembly fragment also preserves every byte. Prepared build
drafts are retained only while their function-partition identity is unchanged;
stale drafts remain as evidence but are not inherited by a newly split assignment.
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
local, so neither manufactures exports or changes encoded relocation addends.
Calls to strong exports use their actual symbols, not aliases defined only in
replaceable assembly fragments: an assembly caller must keep working when its
callee becomes C. The member oracle folds these defined references as described
below; weak/imported references do not gain that equivalence. After updating a
stub generator, regenerate the reference assembly with `split-all`; this
**never overwrites existing source**. There is no original-object fallback
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
survive failure.

Before m2c runs, preparation applies the image path's original-code type
inference to the library. The evidence graph is linked by relocations rather
than addresses: a relocated `jal` is a direct call to the function its
relocation names (in this or another member), an unresolved import is a
contract by name (`extern:NAME`), and relocated storage is identified across
members by its defining member and offset. Seeds are a reference-header
prototype for an exported function, never a private helper of the same name,
or the clean C of a function whose member verifies. Propagation's partial
word-slot constraints reach m2c as `--graph-constraints` keyed by the names its
listing uses (the member's functions, and other members' functions only through
an import). The m2c context and draft gain the reference headers declaring the
target, the member's imports and constrained types; other members' verified
contracts are projected with their private types renamed. A function declared
in the context gets no partial constraint: the declaration is its contract.
The draft's definition of an exported target spells its reference
declaration's types (m2c prints `long` as `s32`, which cc1 rejects as
conflicting). A callee the declared target calls with fewer arguments than the
callee reads (an old-style call, made with no prototype in scope) gets no
constraint and an unprototyped declaration in the draft. The packet records the
graph, propagation report and constraints (`discovery.propagation`); conflicts
and the target's unresolved slots are unknowns. A failed analysis is recorded
and preparation continues with the plain context. Automatic staging accepts generated C but may replace only an
unchanged, committed exclusive function stub. A fresh, exact prepared result is staged and finalized
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
neighbor data. Private BIOS veneers are fingerprinted from original words and
recorded as retained hand-written functions, so they are never queued as C or
granted assembly-policy exceptions.

## Oracle, gates and progress

Acceptance compares the **entire owning member**. Native `original-object`
mode uses the exact contract above. The following legacy ELF-only contract is
retained for `relocatable-object` projects without native originals:

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
- one assembler-era difference is folded, symmetrically, before that strict
  comparison: a reference to a **global symbol defined in the same object** is
  compared as the section symbol plus the symbol value folded into the encoded
  addend (`R_MIPS_32`, `R_MIPS_26`, HI16/LO16 groups with the standard carry).
  Converted PSY-Q objects patch such references section-relatively; GNU as keeps
  the symbol. Both link to identical bytes, and the symbol must still exist at
  the same section offset. Weak, COMMON, absolute and undefined references keep
  their names: those can bind elsewhere at link time.

This is program-content identity, not identical ELF packaging. ELF header flags,
section alignment/entry sizes, empty sections and nonexecutable assembler ABI
bookkeeping are excluded. Debug/file/local-label naming is not program identity. Converted NOTYPE/size-zero
annotations are treated as unknown, not zero-length definitions. Unsupported
formats/relocations produce failure or `UNDETERMINED`, never `MATCH`.
A selected function's manifest-backed INCLUDE_ASM/backlog produces `STUB`, even at
100% words. Directory builds allow **exclusive original backlog files**, not
mixed C/assembly files: each function fragment is one definition or its sole
canonical placeholder; nested function definitions are rejected, and shared
fragments cannot hide functions. Clean fragments
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
  claim completion of the untouched backlog. The named members always
  recompile. Another verified member stands on its record only while the
  record's build identity (target, inputs, sources, headers, tools, flags) and
  verification key (harness implementation and source policy) are unchanged;
  any difference recompiles it. Passing checks retain plaintext tool provenance
  and assembler receipts, but remove temporary candidate objects.
- `library check --accepted`: recompile and recheck every previously verified
  member; the loop's environment guard, **not** an active-target or completion
  gate.
- `npm run progress`: distinguish byte-verified members from reconstructed TUs.
  A function counts as C only when its own file is clean C and its owning member
  has fresh whole-member verification, and as assembly only when its member is
  one verified `.s` or cpp-preprocessed `.ASM`; the two are reported separately (`MATCH-C`/`MATCH-ASM`).
  Neighboring stubs never count as completed. Code-byte completion requires a
  fully reconstructed member. Config, tool,
  target, header or source changes invalidate affected records until rechecked.
  Native diagnostic provenance and publication guards bind the original object
  or archive as well as its validated ELF view, even when callers supply no
  explicit input list. A changed input cannot be stamped against an older
  invocation-local object model.

Library call graphs use member/symbol coordinates, never invented VRAM. Calls
are conservative unambiguous `R_MIPS_26` edges; unresolved relationships are not
liveness evidence. C autoloop targets are exactly the stub functions of C TUs,
minus parked entries and retained functions; assembly TUs are always
`handwritten: "asm"`.

A function of a C member whose original words carry a hand-written fingerprint
(`tools/agent/libraryCodeClass.ts`: BIOS dispatch, syscall/COP0/ABI-register
helpers, an inline BIOS call, or an instruction GCC never emits outside an asm
statement) was an `asm()` body in the original C file. Split records it in the
part as `"retained": { "kind": "handwritten-assembly", "evidence": <class>,
"originalSha256": <original hash> }`. The flag is add-only and explicit in git;
every manifest read recomputes the evidence, and a retained part must stay its
canonical `INCLUDE_ASM` extraction. The graph marks it `handwritten: "asm"` with
`retainedClass`. COP2 (GTE) words are never a fingerprint: Sony wrote GTE code in
C with INLINE_C macros. `npm run library -- code-classes [--json]` is the
read-only census and validation gate: no fingerprint may fall on C source or on a
GTE function. Progress reports `translationComplete` members, whose every part is
C or retained hand-written assembly, beside strictly complete C members.

Parking restores the pre-attempt text of changed neighboring parts and the
selected function's canonical stub, preserving safe attempts under park headers
inside `#if 0`. Other parts remain untouched. Prep uses a preserved selected
attempt as its primary draft instead of silently starting again from m2c.

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
Function-local comparison uses the same defined-reference canonicalization as
the member oracle, retaining raw words/references separately as evidence.
Diff/finalization reports distinguish selected-function agreement from member
failure and locate bounded code differences by section offset and owning
function. An unresolved generated section-reference alias is a scaffold blocker,
not an allocator/scheduler residual or permission to add assembly to matching C.
Neither local agreement nor a scaffold diagnosis grants whole-member acceptance.

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
