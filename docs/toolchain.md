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
  explicitly supported analysis capabilities. The production compile protocol
  is still cpp → cc1 → maspsx → GAS. Configurable executables are not arbitrary
  compiler-driver adapters. GCC-source/RTL analysis is not portable to another
  compiler simply by changing a path. Dumps/emission/implicit-call analyses
  refuse requests without their declared capability.
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

## Commands

```sh
npm ci
npm run setup
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
