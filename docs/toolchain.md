# Toolchain and npm tasks

Install with `pi install --local` and explicitly run
`/skill:psx-bootstrap-project [exe|library]`, or use a cloned/exported template.
[Bootstrap](bootstrap.md) creates project-owned configuration and headers only.
The installed implementation receives explicit package/project/runtime context;
installation alone writes no scaffold. There is no operational Make dependency.

## Configuration

`toolchain.json` is validated by `tools/lib/toolchain.ts` (editor schema:
`tools/lib/toolchain.schema.json`). Builds, function diffs, preprocessing,
preparation, compiler analysis, SDK integration and Pi verification share it.

- `tools`: one executable/script path per entry, **not a shell command**.
  Bare executable names use `PATH`; paths containing `/` are relative to the
  project root (absolute paths also work). Owned paths explicitly select
  `harness`, `project`, `runtime` or `external`; no resolver tries alternate roots.
  Spaces in paths remain one argv
  item. For wrappers, configure an executable wrapper file, not `node file.js`.
  Production preprocessing uses `tools.cpp` without dependency-generation or
  driver-probing flags. Optional `tools.dependencyScanner` defaults to `tools.cpp`
  and uses the period-compatible `-M -MG` protocol; its output discovers inputs
  but never feeds the compiler. Dependency receipts record the scanner's hash;
  changing only the scanner does not change `compilationIdentity`. If `tools.cpp`
  is a driver that delegates preprocessing, explicitly configure
  `tools.cppFrontend` too, so both executables are hashed. Standalone period
  `cccp` needs no frontend entry and is never asked for `-print-prog-name`.
- `compiler`: candidate family/version, optional pinned source directory, and
  optional `analysis: { provider, profile }`. The configured provider supplies
  diagnostic evidence; the harness does not dispatch on compiler versions.
  Legacy `capabilities` remain compatible when no provider is selected, but
  are ignored once `analysis` is configured. The production compile protocol
  remains cpp → cc1 → configured assembler (MASPSX → GAS, or direct GAS with
  unchanged compiler output and explicitly declared period-tool stages); adding diagnostics does not replace it with
  another compiler-driver protocol. Unknown providers report unavailable rather
  than borrowing a GCC parser or pass model.
- `includeDirs`: shared cpp/GAS include search directories, anchored to the root.
- `flags`: argument arrays for cpp, cc1, GAS, linker, maspsx, m2c and spimdisasm.
  Definitions belong in cpp arguments. ASPSX emulation belongs in maspsx arguments;
  direct GAS receives exactly `flags.as`, with no implicit optimization or `-G`.
- `profiles`: named replacements for any flag array (cpp/cc1/GAS/linker/maspsx/
  m2c/spimdisasm), `assembler` and `includeDirs`. Omitted values inherit base; supplied arrays
  **replace**, not append. Production compilation selects the owner profile
  before preprocessing, so its defines/includes travel with its compile flags.
- `containerProfiles`: explicitly select a profile by exact owner id, then
  kind (`exe`, `overlay` or `library`). Unselected owners inherit base flags. There is
  **no automatic `-G8` → `-G0` swap**. Measure each container's ABI first.
- Per-TU overrides live only in `configs/flag_overrides.mk` as
  `CC1FLAGS_<stem> := <extra cc1 flags>`, directly preceded by an evidence
  comment and accompanied by the matching `flag-override` allowlist entry in
  `.pi/autoloop.json`. The shared strict reader rejects unsupported non-comment
  lines with file/line diagnostics. Effective argv is container/profile base
  followed by the applicable override. JSON `fileFlags` is refused.
- `sdk`: explicit version, originals, converted directory, signatures and
  optional headers. Fresh inputs live in `library-input/psyq/{LIB,INCLUDE}`;
  converted objects live in trackable `lib/`. No retained package SDK fallback
  exists. Supply `tools.psyq2elf` for supported LIB/LNK conversion; both colliding
  and non-colliding members retain provenance and refuse differing outputs.

The shipped GCC 2.95.2 / MASPSX (ASPSX 2.80 starting mode) / `-O2 -G8` choices are a **supported starting
candidate**, not facts about a new target. Owners inherit it until
explicitly configured. Do not copy BTN flags, addresses, SDK claims or approvals.
Use `/skill:psx-identify-project` to identify assets and configure a new project.

For linked images, target paths, basenames and segment metadata remain in
splat/container configuration, **not** in the toolchain JSON. Header roles and
human evidence references live in `configs/project-info.json`. Optional root
`project.json` selects `relocatable-library` targets, input globs, immutable/owned
header roles and member profiles; see [Library targets](library-targets.md).
Target adapters expose the same source/assembly/flags/verification contract to
matching tools and skills. Absent manifests or `linked-image` selection use the
EXE/overlay layout. The one-EXE/paired-archive container model remains a convention; see the generalization checklist.

## Assembler backends

Schema v1 keeps `tools.maspsx` and `flags.maspsx` required, even for GAS-only
projects; GAS contexts ignore them. With no `assembler` key, MASPSX and its
legacy argv is unchanged. The provenance identity is versioned: older acceptance
records must be re-verified. Bootstrap retains this default.
An explicit profile assembler replaces the base selection:

```json
"assembler": { "kind": "gas", "objectFormat": "ecoff", "postAssembly": ["psyq-dmpsx", "psyq-lnk"] },
"profiles": {
  "native": { "assembler": { "kind": "maspsx" } }
}
```

`objectFormat` defaults to `elf`; `ecoff` selects native little-endian MIPS
ECOFF output and verification. The configured assembler must actually emit that
format. `inputRewrites` is rejected, including an empty list. Compiler output
feeds `tools.as` unchanged: no move substitution, section renaming or temporary
rewritten input. Choose an identified assembler that implements the target's
operations instead of patching its inputs or outputs.

**`psyq-dmpsx`** is a declared post-assembly stage, a native implementation
of Sony's DMPSX GTE finalization. Its closed placeholder grammar and operand
mapping derive from the SDK's INLINE_S/INLINE_C protocol and COP2 encoding.
Only executable candidate storage is inspected. Recognized placeholders become
COP2 command words; an unknown or relocated placeholder fails. Non-executable
storage and ordinary instructions are untouched. No declaration means no stage.
Every replacement is recorded. The stage identity hashes its implementation
and the object readers it executes; missing implementation files fail closed.
This is not a configurable rewrite channel:
a new stage needs a named period-tool basis and real input/output validation,
not matching-score evidence. Project population validation remains project-owned;
synthetic encoding tests alone do not certify a particular SDK distribution.

`tools/lib/assembler.ts` owns every assembler command and hashes the unchanged
input. It invokes `tools.as` with `flags.as` from the project root, so relative
`.include`s still resolve. MASPSX forces GAS `-G0` unless
`--dont-force-G0` is configured; direct GAS does not. GAS normally requires an explicit
zero threshold because it assumes undeclared externs are small, unlike ASPSX's
declaration-based rule. Direct GAS requires explicit `-G0` in every profile.
`lnkLayout: "early"` changes LNK section IDs/order and empty-section packaging
only; it does not authorize `-G8`. The period stub generator rejects `.sbss` data.

GAS's default optimization permits reorder-mode branch-slot swapping, including
a macro's final word (never a MIPS1 load). `-O` remains an ordinary `flags.as`
argument; lowering it requires target evidence, not a matching-score guess.
MASPSX forces noreorder at compiler function boundaries and inserts hazard nops
into its text. GAS inserts hazards internally, so compiler-text attribution
cannot see them: inspect the object or listing instead.

Expansion capture preserves MASPSX's text output. GAS retains its original
input and `<object>.listing.txt` (`-alm`). A separate listing assembly runs the
same declared stages and must equal the production object. Receipts retain both
argvs, input/output hashes, stage versions/implementation hashes and replacements.
Accepted library receipts survive candidate-directory cleanup. Assembly source
policy checks both the original `.ASM` and its cpp expansion, so a header or
local define cannot hide raw instruction words. Executable data directives
(`.word`, `.half`, `.byte`, `.int`, `.long`, `.fill`, and nonzero-filled `.space`)
are rejected, including symbolic words and invalid instruction encodings. The
exceptions are recognized SDK placeholders with DMPSX declared and printable
`.ascii`/`.asciz` text. Literal `#if 0` attempts are preserved but not audited as
active source. Backlog status comes from TU manifests, not `.NON_MATCHING`
symbols. These source checks do not apply to generated reference listings.

Acceptance checks configured `toolPins` (SHA-256 plus optional recipe digest)
and the configured compiler's source/binary binding on every run. Native
original-object acceptance requires cpp, cc1 and as pins (and a frontend pin when
cpp explicitly delegates to one). Plaintext accepted
records identify these tools, recipes, object format and stages. Identities hash
MASPSX's implementation package, not just its launcher, and linked libraries of
host executables, not just binutils launchers. Scanner changes do not change
production-byte identity; production cpp changes do.

**`psyq-lnk`** must be the last post-assembly stage and requires ECOFF. It reads
only the candidate, emits Sony LNK v2, and retains the raw assembled ECOFF next
to the output as `<object>.ecoff`. Its closed `lnkLayout` table is `standard`
(default) or `early`; the selected layout and implementation hashes enter
identities and receipts. Unknown sections, symbol classes and relocations fail.

`original-object` acceptance compares the complete original and rebuilt `.OBJ`
SHA-256 hashes. A mismatch reports the first differing LNK record; no section,
symbol, alignment, relocation or record-order normalization can grant acceptance.
Accepted records retain both hashes and pinned tools; failed member records
retain the candidate path and first differing record. Successful compile bundles
are removed, including retained ECOFF; only the newest failed candidate bundle
per member remains. Cross-format comparison
is diagnostic only: ECOFF has no encoded alignment, so its diagnostic reader
retains `null` rather than inventing BFD's default.

SDK conversion requires an identified `tools.psyq2elf`; optional `flags.psyq2elf`
passes explicit converter-specific options before the input/output paths. The
converter hash, arguments and linked-library hashes participate in extraction
identities and member receipts; preexisting converted objects cannot certify themselves. Converted objects link directly. There is no
SDK data/rdata copying, unconditional HI16 correction or BSS symbol/header
patching. A converter-specific carry bug must be fixed and validated in that
identified converter, never repaired against the target image. BSS placement
belongs exclusively in the linker script. Image checks reject trailing payload
bytes and differing entry/gp/load-address/payload-size fields. Engine candidates
must pass the whole container/member gate before publication; a function score
or an unavailable check never licenses publication.

`identify` reports per-member indexed-load scratch relations (`gas-rule`,
`aspsx-rule`, or ambiguous), plus native LNK packaging when supplied through
`sdk.originalDir`. For `l* D,sym(B)`, GAS uses D when D != B and `$at` otherwise;
ASPSX uses `$at`. Absolute loads reuse D under either backend; stores use `$at`.
Thus absolute self-clobber pairs are expected assembler expansions, **not**
compiler address-splitting fingerprints. Converter-style section IDs (`0xF001`),
absence of file records and native IDs (`1`), constructors/destructors and file
records are separate packaging witnesses. Incomplete parsing is reported, never
read as absence evidence. No report automatically changes configuration or
identifies an assembler release. Keep target-specific conclusions in the project.

## Project-owned compiler source

Declare the source of the **configured production compiler**, not whichever GCC
release the package happens to contain. `compiler.source` accepts an explicitly
owned directory with `pin.json` and `src/gcc/…`. Both default queries and internal
resolved-version calls retain this directory. The pin identifies the GCC version,
upstream archive, recipe/patch inputs, content-hashed source tree and associated
`cc1` SHA-256. Source queries reject tree drift (including cached queries), version
contradictions and compiler-binary binding mismatches.

For an existing compiler and an explicit project-owned old-gcc Docker recipe:

```sh
npm run prepare-compiler-source -- --recipe PATH/TO/Dockerfile --destination tools/vendor/gcc/VERSION-psx
npm run compiler-source -- verify --json
```

With an installed package, invoke these scripts through its `scriptHost.ts` with
`--project PROJECT`, as for other installed tasks. Provisioning rebuilds the same
recipe with a post-build source export and refuses publication unless `cc1`
reproduces the currently configured binary's hash. It never replaces that binary,
changes flags or downloads target/SDK assets. Source-only publication retains
licenses, the recipe and patches; binary exports stay under ignored `build/`.
Normal supported compiler builds now retain `compiler-source/` and record its
hash alongside compiler provenance. New scaffolds point at that project runtime
bundle. Existing binary caches without source are preserved, not silently rebuilt.

An explicit different `--version` is **cross-version reference only** and emits a
compatibility warning. Missing source or an unsupported analysis capability is
not permission to change the production compiler. Source availability alone does
not implement an RTL/scheduler/oracle provider.

## Configured diagnostic providers

Select a protocol implementation and a project-owned runtime evidence profile:

```json
"analysis": {
  "provider": "gcc-rtl",
  "profile": { "origin": "runtime", "path": "analysis/compiler.json" }
}
```

Run `npm run analysis-support -- bootstrap [--function KEY]`, then
`npm run analysis-support -- status`. Installed-package consumers can proxy
`tools/agent/analysisSupport.ts` through `scriptHost.ts --project PROJECT`, as
with the compiler-source tools. The optional function selects its production
owner flags and per-TU overrides. Bootstrap uses small diagnostic-only probes;
actual function diagnostics still compile the ordered production TU.

The installed `gcc-rtl` provider is a protocol/parser, not a release whitelist.
Bootstrap retains inputs, argv, stdout/stderr, instruction counts and unchanged
compiler-assembly evidence under `build/analysisSupport/`. Profiles bind to the
configured compiler binary and optional source pin; mismatches disable support.
Status does not compile, provision or replace a compiler. Bootstrap also requires
the configured compiler to exist. No production flags, source or target inputs
are changed.

Native GCC RTL support enables the inherited allocation, scheduling and loop
diagnostics; bootstrap's unset `passModel` and empty `stageOrder` are not an
approval gate. Observed dump facts remain distinct from reconstructed/inferred
conclusions. Without a configured pass order, tracing uses common GCC ordering
and labels cross-stage transitions inferred. Missing or unreadable inputs limit
only their dependent analyses, not the whole diagnostic backend.

Compiler trace, target-schedule and explain-diff accept `--src` (tool parameter
`src`) for an explicit diagnostic candidate. An assembly-backed live stub is
not a candidate C program. Named-function RTL and assembly selection occurs
before analysis; target scheduling reads the selected function's production
object words, not unexpanded cc1 macro lines. Register numbering is read from
the configured pinned MIPS compiler source inside the active project context,
not from a fixed pseudo threshold. Missing register evidence leaves native RTL
readable while register-dependent interpretations are unavailable.

Flag-probe also accepts `--src` (tool parameter `src`) to select the primary C
candidate in its original production TU. INCLUDE_ASM backlog supplies original
fingerprints only, never a compiler-flag matrix: recompiling assembly under a
compiler flag cannot validate that flag. `--with-source` rows are advisory and
cannot own a conclusion for an unmeasured primary. Reports bind the selected
source path/status/hash, target and toolchain; unsupported flags retain the
compiler's error and remain inconclusive. Triage reads symbolic original words,
including ET_REL relocation fixups, rather than assuming literal `%hi/%lo` in
the disassembly file. These fingerprints nominate compiler-specific experiments;
they do not recover original compiler input or identify a compiler version.

Residual-objective JSON retains stub status, raw differences, interpretation
confidence and ownership. A zero modeled key with differing words is explicitly
an unexplained byte residual; work is selected from the best measured nonstub.
Allocation agreement requires complete correspondence of surviving value webs
(after coalescing); unpaired values are reported explicitly and the partial
allocation term cannot rank candidates or license allocator-only directions.
Raw differences and native RTL are the default evidence path, not an automatic
assembler-expansion dump. Candidate build receipts do not recover original
compiler input.
Residual-objective runs preserve each invocation in a new `objective/measurement-*`
directory, with selected-source snapshots, full-object hashes and report references.
The source fragment is still compiled in its original production TU; its snapshot
is evidence, not an independently compiled replacement. Explicit source paths are
validated before creating run state, and a selected source changing during the
measurement prevents recording the result. Historical mutable-cache paths are not
upgraded into immutable evidence. Program-level ledger deduplication is unchanged;
the invocation's manifest preserves receipts even when its program was measured
before.

Idiom retrieval excludes classified assembly-backed platform macro invocations,
not just literal `asm`/`INCLUDE_ASM`. Its coverage distinguishes eligible clean-C
functions from those contributing searchable regions. For a query containing an
indexed LUI/ADDU/load relation, it also counts that scratch-register relation in
every eligible function's original words, including functions too short to form
an indexed region. Counts are exhaustive only when every named function is read;
limited example lists do not limit counts. This census establishes a raw register
relation, not original compiler input or assembler behavior. Raw compiler-source grep
covers C, headers and machine descriptions independently of C-parser health; a
file filter selecting no covered files fails without performing a search.

Recipe-atlas/near-miss image flag columns currently refuse library targets
explicitly, before any EXE lookup or catalogue compilation.

Pre-delay-slot replay checks the configured snapshot or `.mach` when it exists.
A missing `.mach` is not repaired by renaming `.jump2`: reversal still reports
provisional source hypotheses, residuals and raw differences. Observed pseudo
counts are not round-trip verification. Zero normalized residual does not prove
an assembler cause when bytes still differ. None of this changes the production
whole-TU byte oracle.

Instrumentation uses the configured source pin and its build recipe/context,
with binary/tree binding and exact patch-anchor checks. There is no hardcoded
fallback compiler. Missing anchors require an instrumentation port to that
source; they do not disable native RTL, scheduler or loop diagnostics.

On a machine-word residual, reversal/objective reports retain the compiler
pseudo-instructions, the configured assembler expansion and an argv/hash receipt.
The **configured assembler is the only acceptance path**; assembling through any
other backend is diagnostic only. Changing an owner's assembler requires
original-word assembler-family evidence and re-verification of its members.
The original bytes alone do not prove that the compiler emitted an explicit
address pseudo. Diagnostic capture does not change production flags or weaken
the normal whole-output verification gate.

## Commands

```sh
npm ci
npm run setup
npm run analysis-support -- status           # configured diagnostic availability
npm run analysis-support -- bootstrap       # explicit small protocol probes
npm run profile -- --write                 # once target metadata is available
npm run identify -- --json                 # evidence vs configured choices
npm run disassemble                       # main EXE, two disassembly passes
npm run disassemble -- --archives          # opt into paired-index archive adapter
npm run split                             # main EXE pipeline
npm run split -- --container ovl_1
npm run split-all
npm run build -- --container exe
npm run check                             # main EXE, full payload bytes
npm run check-all                         # every configured, resolved container
npm run diff -- FUNCTION
npm run progress                          # former make progress
npm run scan-handwritten -- --output build/handwrittenAssembly/report.json
npm run config-check                      # split-all + tracked config/header diff
npm run clean
npm run wipe -- --container ovl_1
```

`build`, `check`, `split`, `disassemble`, `clean` and `wipe` also accept `--all`.
The `*-all` tasks select all containers; `check-exe` names the executable check.
`config-check` needs Git and guards tracked files only; review new outputs too.
`clean --container` is scoped; plain `clean` removes known derived build outputs
and preserves durable ledger/preparation/evidence records. `wipe`
removes generated configuration, never original target assets or recovered C.
Do not run destructive commands merely to identify an unfamiliar project.

`scan-handwritten` is an advisory original-word census for images and ELF/ar
members, not a build or conversion step. It protects existing C and records
confidence evidence without compiling or emitting source. See
[handwritten-assembly heuristics](handwritten-assembly.md) for thresholds,
installed-package invocation and limitations.

The incremental build hashes configuration, executable contents, environment,
include-directory membership, actual cpp header dependencies and INCLUDE_ASM
inputs. Objects/link outputs carry content records; modified/missing artifacts
cannot be reused merely because their timestamps look recent. Link keys include
SDK objects and engine/symbol inputs. SDK repair and cross-file reference passes,
engine exports (with explicit fallback when the EXE cannot link), and one bounded
rodata rederive/re-split retry preserve the inherited convergence behavior.
`check-all` byte-checks containers then checks rodata derivation once globally.
Unresolved code members are reported, **not** claimed verified. Per-function
matches do not replace this final oracle.

For ELF/ar and Sony LIB/LNK targets, `split`/`split-all`/`disassemble` scaffold member TUs
with INCLUDE_ASM; `build` compiles present TUs; `check`/`check-all` build every
member and report every failure, including nonmatching stubs. Matching backlog
is byte-verified but never counted as reconstructed C/assembly. `progress` reports fresh member
verification. Use `npm run library -- --help` for inventory, preparation and
scoped member checks. Image-only SDK integration/config-check/wipe tasks are not
library adapters. Plain `clean` removes build outputs, not original inputs/C.
The linked-image incremental/link behavior described above remains unchanged.

`npm run bootstrap -- --mode exe|library --root DIRECTORY` previews a source
scaffold; add `--write` to apply. It preserves input/configuration files and
refuses implementation/task conflicts. In an installed package, use the Pi
bootstrap skill/tool or the absolute script path documented in
[bootstrap.md](bootstrap.md), not commands run in the package checkout.
Bootstrap prints a supply checklist before any target is present.

## Fresh clones and exports

A recursive clone supplies pinned vendors:

```sh
git clone --recurse-submodules REPOSITORY project
cd project
npm ci
npm run setup
```

`setup` prepares pinned public dependencies and patched m2c in the runtime cache,
without initializing consumer submodules. The supported default compiler is
provisioned on demand through the package Docker recipe, never copied from local
builds. Configure custom compiler executables and external Python/cross-binutils/
splat/spimdisasm capabilities explicitly. No proprietary input is downloaded.

A degit/archive export may omit submodules. Either populate the exact revisions
recorded in `.gitmodules`/`docs/migration.md`, or use a recursive clone to obtain
vendor sources before exporting. A complete m2c snapshot works without Git
metadata only when its file count/content digest matches the pinned upstream
snapshot in `tools/vendor/m2c-patches/upstream-files.json`. Missing or edited
sources fail clearly; no unchecked fallback is accepted. An explicitly configured
external m2c is used as an external tool and is not claimed to carry our patches.

No target assets are distributed. Without target/layout/splat inputs, `build`,
`check`, `split`, and `progress` cannot establish a result. Help and the shallow
identification report still work. `npm test` uses isolated synthetic projects for
portable contracts; provisioned compiler/binutils/Python tools are still required.
Historical original-asset tests remain optional, and strict TypeScript checking
still has inherited errors. See [fixture scope](../test-fixtures/harness/README.md).
