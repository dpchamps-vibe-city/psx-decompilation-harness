# Toolchain and npm tasks

Use this repository as a **cloned/exported project template**, with target assets,
configuration and harness tools in the same tree. It is not an installed CLI.
The root Makefile has been removed; the original remains in the BTN example.

## Configuration

`toolchain.json` is validated by `tools/lib/toolchain.ts` (editor schema:
`tools/lib/toolchain.schema.json`). Builds, function diffs, preprocessing,
preparation, compiler analysis, SDK integration and Pi verification share it.

- `tools`: one executable/script path per entry, **not a shell command**.
  Bare executable names use `PATH`; paths containing `/` are relative to the
  repository root (absolute paths also work). Spaces in paths remain one argv
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
- `profiles`: named replacements for cc1/GAS/linker/maspsx arrays. Omitted arrays
  inherit base; supplied arrays **replace**, not append. Preprocessing and include
  search remain project-wide, so every diagnostic sees the same declarations.
- `containerProfiles`: explicitly select a profile by exact container id, then
  kind (`exe` or `overlay`). Unselected containers inherit base flags. There is
  **no automatic `-G8` → `-G0` swap**. Measure each container's ABI first.
- `fileFlags`: extra cc1 arguments keyed by source/function stem. These still
  require project evidence and policy allowlisting. Workers cannot edit the
  toolchain to manufacture a match; configuration changes require human review.
- `sdk`: selected version, original LIB directory, converted object directory,
  and version-specific signature directory. Selection is not identification.
  The retained SDK/header/object assets are 4.7; another release requires its
  own coherent inputs. `tools.psyq2elf` optionally supplies the converter.

The shipped GCC 2.95.2 / ASPSX 2.80 / `-O2 -G8` choices are a **supported starting
candidate**, not facts about a new game. Both container kinds inherit it until
explicitly configured. Do not copy BTN flags, addresses, SDK claims or approvals.
Use `/skill:psx-identify-project` to identify assets and configure a new project.

Target paths, basenames and segment metadata remain in splat/container project
configuration, **not** in the toolchain JSON. Header roles and human evidence
references live in `configs/project-info.json`. Root paths and the current
one-EXE/paired-archive container model are still conventions; see the migration
checklist for boundaries that need generalization.

## Commands

```sh
npm ci
npm run setup
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
`clean --container` is scoped; plain `clean` deletes build outputs. `wipe`
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

## Fresh clones and exports

A recursive clone supplies pinned vendors:

```sh
git clone --recurse-submodules REPOSITORY project
cd project
npm ci
npm run setup
```

`setup` initializes Git submodules and prepares patched m2c. It does **not** build
or download compiler binaries, install system tools, or obtain proprietary game
assets. Follow `tools/vendor/old-gcc/README.md` to provision the configured cc1;
install/configure Python, cross-binutils, splat and spimdisasm yourself. The local
ignored compiler build is not a portable distribution.

A degit/archive export may omit submodules. Either populate the exact revisions
recorded in `.gitmodules`/`docs/migration.md`, or use a recursive clone to obtain
vendor sources before exporting. A complete m2c snapshot works without Git
metadata only when its file count/content digest matches the pinned upstream
snapshot in `tools/vendor/m2c-patches/upstream-files.json`. Missing or edited
sources fail clearly; no unchecked fallback is accepted. An explicitly configured
external m2c is used as an external tool and is not claimed to carry our patches.

No target assets are distributed. Without target/layout/splat inputs, `build`,
`check`, `split`, and `progress` cannot establish a result. Help and the shallow
identification report still work. The inherited test/typecheck suite has known
project-dependent failures; scaffolding validation is deliberately narrow.
