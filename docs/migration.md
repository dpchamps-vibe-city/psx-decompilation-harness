# Migration record

## Follow-up: configured assembler backend

Production now uses cpp → cc1 → configured assembler: legacy MASPSX → GAS by
omission, or direct GAS with closed compatibility rewrites. Legacy argv and v1
compilation identities are preserved when omitted. Assembler profiles replace
the base selection and require original-word evidence and member re-verification;
see [toolchain backends](toolchain.md#assembler-backends). Historical MASPSX
measurements below describe that route, not a restriction on GAS acceptance.

## Source and scope

Source: `../btn-decompilation`, base HEAD
`7e8ea2695f1231f11c589e777f420149362719a8`. This is a **working-tree copy**,
not a pristine export of that commit. At the start the source had edits to:

- `configs/flag_overrides.mk`
- `include/globals_override.h`
- `src/overlays/ovl_11/ovl_11_func_800FD034.c`

The first two were preserved in the historical support snapshot. Game `src/` was
not copied. This migration did not write to the original repository. A final
read-only status check showed ongoing source-tree changes: the flag override was
no longer dirty and `notes/human-needed-approvals/ovl_11_func_800FD034.md` had
appeared. Those later changes were not mirrored or restored; the historical
example remains the initial working-tree snapshot.

No destination commit was made. Git was initialized on `main`; only submodule
registration staged `.gitmodules` and the four gitlinks.

## Follow-up: installable onboarding and local library inputs

The repository now declares a Pi package entrypoint for explicit bootstrap:
`pi install --local` followed by `/skill:psx-bootstrap-project [exe|library]`.
Bootstrap creates project-owned scaffolding while harness tools run from the
installed package with explicit project/runtime roots. It obtains missing public
tooling at the pins below without importing Git metadata into the consumer repo;
private game/SDK inputs are never fetched.
See `docs/bootstrap.md` for scope, supply instructions and re-run safety.

All former contents of root `lib/` were removed. It is now a trackable local
library-target/conversion directory, created empty by bootstrap. `library-input/`
is the ignored original-library input boundary; `extracted/` remains the ignored
game input boundary. Bootstrap does not copy retained `tools/vendor/psyq47/` reference SDK
assets or `include/psyq/` headers. The initial duplication inventories below
are historical, not a claim that those converted objects are still shipped.

## Follow-up: prune project history

After the duplication audit, the user requested removing game planning/research
material from the harness:

- Deleted all of `plans/`: 75 files, approximately 1.3 MB.
- Deleted 221 note files: function research/retros, approvals, ROM analysis,
  asset/provenance ledgers, file-grouping evidence, implementation/session logs,
  old tasks, and scratch work.
- Retained only `notes/tools-directory-structure.md` and a rewritten notes README;
  the inventory has a migration warning and still needs stale-reference cleanup.
  The notes tree shrank from roughly 6 MB to 60 KB on disk.
- Deleted material was not moved into another directory/archive in the harness.
  The source repository was not modified.
- Repointed `tools/agent/compiler-oracle/instrumentation.ts` from scratch copies
  of `local-alloc.c`/`sched.c` to `tools/vendor/gcc/2.95.2/src/gcc/`. Both source
  pairs were byte-identical before deletion; the adapter remains profile-specific.
- Updated root documentation and the generalization backlog. Some inherited
  prompts/diagnostic citations still name removed notes/plans; missing historical
  evidence is not replaced with implicit source-repository reads or invented facts.
  Optional file-group lookup already returns no groups when its ledger is absent.
- Focused post-pruning validation passed all **37 tests** across compiler-oracle,
  compiler-source, file-grouping, migration, and doc-reference contracts. The full
  inherited suite was not rerun for this pruning step.

The copy audit and validation below describe the **initial duplication**, before
this intentional pruning, not the current note/plan inventory.

### Initial inventory

- All selected `.pi/` extensions, skills, settings, and loop configuration.
- All first-party `tools/`, including `tools/build/` sources hidden by the old
  unanchored build ignore rule.
- Necessary vendor sources/assets and the locally built active compiler profile.
- `lib/`, `prompts/`, `notes/`, `plans/`, and `test-fixtures/`, preserving historical
  implementations and research references rather than designing a replacement.
- Original `configs/`, headers, Makefile, and loop policy under
  `examples/btn-decompilation/` (not active target inputs).
- Original root guides under `docs/btn-decompilation-{README,AGENTS}.md`.
- Package/lock, TypeScript configuration, and Makefile, with the narrow migration
  edits described below.

At initial duplication, notes/reports and regression fixtures preserved original
game names, addresses, snippets, and research artifacts. Most notes and all plans
were subsequently removed as described above. Remaining historical references
and fixtures are not current verified facts or transferred policy approvals.

### Excluded

| Source path/material | Reason |
| --- | --- |
| `tools/vendor/silent-hill-decomp/` | Unneeded game-specific reference checkout; explicitly excluded as requested |
| `tools/vendor/homebrew-psyq/`, `tools/vendor/psyq_sdk/` | No production dependency found in the migrated first-party tooling; reference/duplicate SDK trees |
| Old compiler build directories other than `build-gcc-2.95.2-psx/` | Obsolete local outputs, not active dependencies; upstream build recipes remain |
| Redundant SDK ZIP/7z archives | Unpacked necessary SDK inputs retained |
| Source `.git/`, credentials/environment files, caches, logs, autonomous run state | Not harness implementation; new git metadata is independent |
| Game `src/`, `extracted/`, root `build/`, `run_output/` | Recovered source and target/runtime outputs do not belong to the harness |
| Generated `*.m2c` header side files, Python bytecode | Reproducible preprocessing/cache outputs, not source inputs |

Testing creates new ignored outputs under this repository's `build/` and possibly
`run_output/`; these are not copied game outputs.

## Retained vendor inventory

Four independent pinned checkouts were cloned with `--no-hardlinks`, their remotes
restored to upstream, registered as submodules, and gitdirs absorbed into the
**destination** `.git/`. They have no source-tree git pointers or alternate object
stores. Original submodule section names were preserved; paths remain under
`tools/vendor/`.

| Path | Upstream | Pin |
| --- | --- | --- |
| `tools/vendor/old-gcc` | `decompals/old-gcc` | `c8c4b40f105375d575c030b28f23d6370d676268` |
| `tools/vendor/maspsx` | `mkst/maspsx` | `0249ed2752a100eed95e8b4124f94af859398ca9` |
| `tools/vendor/m2c` | `matt-kempster/m2c` | `cd96c559d54ea8644177e89cee07e4f0b0ac4825` |
| `tools/vendor/psx_psyq_signatures` | `lab313ru/psx_psyq_signatures` | `e9e46e7e133ef275a79bfce650924f98edb086bc` |

Other retained dependencies:

- `tools/vendor/gcc/2.95.2/`: pinned patched compiler sources for forensic analysis.
- `tools/vendor/m2c-patches/`: manifest plus four source patches. `prepareM2c.ts`
  verifies a clean pinned upstream checkout and materializes patches into ignored
  `build/vendor/m2c/<identity>/`; it requires actual git history, not a loose snapshot.
- `tools/vendor/psyq47/`: original LIB/INCLUDE/DOCS and converted inputs consumed
  by inherited SDK verification/build tools.
- `tools/vendor/splat_ext/o.py`: retained splat object-segment adapter.
- `tools/vendor/tree-sitter-c/`: WASM grammar, identity pin, upstream notice.
- `tools/vendor/old-gcc/build-gcc-2.95.2-psx/`: locally duplicated compiler build
  including `cc1` and companion binaries, ignored and not a portable distribution.

All signature database versions were retained; selecting/validating SDK versions
still needs generalization. Retained third-party assets keep their upstream
notices. SDK redistribution rights need review before publication.

For a later checkout, initialize the submodules with
`git submodule update --init --recursive`. The old-gcc upstream build entry point
is `make -C tools/vendor/old-gcc VERSION=2.95.2-psx` (Docker required); reproducing
and validating the exact local compiler/source relationship on a fresh machine
remains an open setup task, not a claimed completed build test.

## Narrow migration edits

- New generic `README.md`/`AGENTS.md`, provenance notices, this record, and the
  prioritized [game-agnosticity checklist](game-agnosticity.md).
- Root `include/` contains retained platform/SDK headers plus generic scalar/macros
  and empty globals/type roles. BTN structs/declarations remain in examples.
- Root `configs/` contains header roles but no active game profile, splat, symbols, SDK acknowledgements or overlay manifest. Tool/flag/SDK selection now lives in `toolchain.json`.
- `.pi/autoloop.json` disables commits and clears the inherited symbol allowlist.
  Other supported policy mechanisms remain; no blanket authorization is implied.
- The root Makefile/path example was subsequently replaced by npm tasks and validated toolchain JSON; the original Makefile remains only in the example. See `docs/toolchain.md`.
- Six targeted tool edits: measured/configured bounds in `classifyGlobals.ts`,
  configured basename in `genProjectProfile.ts`, linker paths in `patchLibBss.ts`
  and `patchLinkerBss.ts`, measured bounds/paths in `diffBinary.ts`, explicit or
  discovered executable in `headerInfo.ts`.
- `classifyGlobals.ts` exposes declaration helpers without executing its CLI on
  import, plus an explicit input seam for synthetic binary/layout tests.
- Package identity changed to `psx-decompilation-harness`, marked private;
  dependency versions and inherited commands remain. TypeScript excludes vendor
  and historical examples. Anchored output ignores no longer hide `tools/build/`.
- New `tools/lib/gameAgnosticity.test.ts` uses synthetic alternate-file/load/layout
  inputs, negative bounds, discovery, scaffolding/policy, and vendor-isolation checks.

## Initial copy audit (before pruning)

SHA-256 comparison against the source at audit time found **no missing eligible
files** within the chosen scope. This is a snapshot audit, not continuous
mirroring of ongoing source development. Vendor/git/cache/generated exclusions
above were applied.
New documentation/tests are additions, not included in these source-match counts.

| Source area / destination | Byte-identical files | Intentional changes |
| --- | ---: | --- |
| `.pi/` | 82 | 1: active loop config |
| `tools/` (including retained vendor source/assets) | 5,103 | 6: targeted tools listed above |
| `lib/` | 2,170 | 0 |
| `prompts/` | 12 | 1: README provenance notice; original text retained |
| `notes/` | 222 | 0 |
| `plans/` | 74 | 0 |
| `test-fixtures/` | 19 | 0 |
| `configs/` → historical example | 45 | 0 |
| `include/` → historical example | 87 | 0 |

No source-coupled symlinks were found in the migrated trees. Submodule HEADs,
local gitdir locations, absence of object alternates, and upstream origins are
also checked by the new migration tests.

## Initial validation (before pruning)

Environment: Node `v24.1.0`; npm installation succeeded with `npm ci --no-audit
--no-fund`. All commands ran in the destination, not the source repository.

| Check | Result |
| --- | --- |
| New migration tests + inherited global-declaration tests | **14 passed**, 0 failed |
| Focused portable/toolchain smoke selection (14 files) | **90 passed**, 0 failed, 2 existing skips |
| Pinned compiler source verification | Passed: GCC 2.95.2 source tree hash `10e9345add3f472a9b646879aa71293b23a37dc3b81b7e257982ee0d61686ab0` |
| Pinned tree-sitter C front end | Passed: version 0.24.1, ABI 15, grammar hash `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |
| Pinned patched m2c preparation + Python CLI help | Passed; upstream remained clean |
| Tiny synthetic C89 file → cpp → cc1 → maspsx → assembler | Passed; MIPS ELF object and expected symbol verified |
| Full inherited `npm test` | **1,130 passed, 53 failed, 112 skipped**; 1,295 total, about 23.4 s |
| Strict `tsc --noEmit` | Fails; inherited import-extension/optional-value/indexing and other typing errors remain |
| Whole game/container matching | **Not run**: no game inputs supplied; smoke compilation is not target-byte verification |

The earlier raw-copy baseline had 1,133 passed, 119 failed, 32 skipped (1,284
total). After isolating BTN inputs, some existing test guards skip absent inputs;
no migration change added blanket skips. These are not comparable green-suite
claims.

Remaining failures include target/container metadata dependencies in loop/prepared
attempt tests, missing generated `include/functions.h` in context-export tests,
BTN headers/source/layout/census expectations, and branch-orientation/static
preparation/verified-seed assertions. Not every assertion failure has been
attributed to missing inputs; those need independent investigation. Do not fix
this by importing game state, weakening checks, or silently hiding failures.

Session logs (temporary, not tracked):

- `/tmp/psx-harness-tests-baseline.log`
- `/tmp/psx-harness-tests-final.log`
- `/tmp/psx-harness-migration-tests.log`
- `/tmp/psx-harness-smoke-tests.log`
- `/tmp/psx-harness-toolchain-smoke.log`
- `/tmp/psx-harness-typecheck.log`
- `/tmp/psx-harness-copy-audit.json`

## Toolchain/npm scaffolding

- Root Makefile and empty Make configuration removed; original build file stays in the example.
- Shared `toolchain.json` and schema drive executable paths, argument arrays, SDK inputs and explicitly selected container profiles throughout builds, diagnostics and Pi gates. No implicit overlay `-G0` substitution.
- npm tasks retain splitting/SDK/engine/rodata convergence, incremental dependencies and full-container byte verification; `npm run progress` is retained.
- Pinned m2c sources work as a verified Git-free snapshot; absent/edited vendor sources fail rather than falling back unchecked.
- Identification separates configured choices from asset evidence. `.pi/skills/psx-identify-project/SKILL.md` guides configuration from the current project's assets and reports unknowns.
- Lean validation: 51 existing focused checks passed. Real cpp/cc1/maspsx/GAS smoke compilation, profile/path resolution, Git-free m2c preparation/edited-source rejection, and skill references passed. No broad new test suite was added.
- Full target-byte verification remains unavailable without assets. Strict TypeScript still has inherited errors; the new config/pipeline/setup/identification modules reported no errors in the focused typecheck inspection.

Usage is a cloned/exported project template, not a separately installed harness.
Further compiler adapters, coherent alternate SDK inputs, container/ABI models,
evidence isolation and inherited test cleanup remain documented in
[game-agnosticity.md](game-agnosticity.md).

## Portable fixture follow-up

Previously failing game-dependent tests now use isolated synthetic projects,
small borrowed control shapes and independently compiled references. Container,
profile and header lookups accept project roots where those contracts need them;
ROOT-bound integration modules run in a temporary harness tree. No game state
was imported or new missing-asset skips added. See
[test-fixtures/harness/README.md](../test-fixtures/harness/README.md).

Full `npm test`: **1,202 passed, 0 failed, 112 existing optional cases skipped**
(1,314 total, about 32 s). Those original-asset cases remain unconverted. Strict
`tsc --noEmit` still fails on inherited errors; the two new fixture helpers report
none. No game/SDK binary-identity result or commit is claimed.
