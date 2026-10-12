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
- `compiler`: candidate family/version, optional pinned source directory, and
  optional `analysis: { provider, profile }`. The configured provider supplies
  diagnostic evidence; the harness does not dispatch on compiler versions.
  Legacy `capabilities` remain compatible when no provider is selected, but
  are ignored once `analysis` is configured. The production compile protocol
  remains cpp → cc1 → maspsx → GAS; adding diagnostics does not replace it with
  another compiler-driver protocol. Unknown providers report unavailable rather
  than borrowing a GCC parser or pass model.
- `includeDirs`: shared cpp/GAS include search directories, anchored to the root.
- `flags`: argument arrays for cpp, cc1, GAS, linker, maspsx, m2c and spimdisasm.
  Definitions belong in cpp arguments; assembler semantics in maspsx arguments.
- `profiles`: named replacements for any flag array (cpp/cc1/GAS/linker/maspsx/
  m2c/spimdisasm) and `includeDirs`. Omitted values inherit base; supplied arrays
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

The shipped GCC 2.95.2 / ASPSX 2.80 / `-O2 -G8` choices are a **supported starting
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

Residual-objective JSON retains stub status, raw differences, interpretation
confidence and ownership. A zero modeled key with differing words is explicitly
an unexplained byte residual; work is selected from the best measured nonstub.
Allocation agreement requires complete correspondence of surviving value webs
(after coalescing); unpaired values are reported explicitly and the partial
allocation term cannot rank candidates or license allocator-only directions.
Raw differences and native RTL are the default evidence path, not an automatic
assembler-expansion dump. Candidate build receipts do not recover original
compiler input.
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
pseudo-instructions, the configured MASPSX expansion and an argv/hash receipt.
MASPSX → GAS is the production protocol: assembling cc1's `.s` directly with GAS
can choose another scratch register and is not an acceptance oracle. The original
bytes alone do not prove that the original compiler emitted an explicit address
pseudo. Diagnostic expansion capture does not change the normal TU build or
whole-output verification gate.

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

For ELF/ar targets, `split`/`split-all`/`disassemble` scaffold member TUs
with INCLUDE_ASM; `build` compiles present TUs; `check`/`check-all` require every
member to be clean C and whole-object matching. `progress` reports fresh member
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
