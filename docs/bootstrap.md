# Install and bootstrap a project

Install a reviewed package with Pi's supported package flow:

```sh
mkdir my-psx-project && cd my-psx-project
pi install --local /absolute/path/to/psx-decompilation-harness
pi
```

A reviewed Git package source also works. Pi owns the package declaration in
`.pi/settings.json`; bootstrap neither edits it nor guesses Pi's cache layout.
Pi 0.85.1 is exercised by the installed-runtime tests. Package peers are `*`,
not consumer dependencies pinned to the development test host.

```text
/skill:psx-bootstrap-project          # executable project
/skill:psx-bootstrap-project library  # ELF/ar library project
```

Installation exposes matching/resource tools and skills directly from the
package. No project configuration is needed to load them; target operations
before bootstrap explain the missing configuration. Reload Pi after installing
or updating resources. Bootstrap does not copy tools, extensions, skills,
reference sheets, vendor trees or AGENTS.md into the target repository.

## Project ownership

Bootstrap adds missing project headers, sources/configuration directories,
`project.json`, `toolchain.json`, `.pi/autoloop.json`, the format-only
`configs/flag_overrides.mk`, project resource-plugin directories/registry,
`.gitignore` rules and `README.psx.md`. Existing files, npm tasks, Pi settings,
plugins, overrides and inputs are preserved. It creates no replacement guide.

| Location | Ownership and purpose |
| --- | --- |
| `src/`, `include/`, `configs/` | Reconstructed project sources, declaration roles and target configuration |
| `extracted/` | Supplied original extracted game inputs; writable extraction results remain project-local |
| `library-input/psyq/LIB/` | Supplied original SDK libraries |
| `library-input/psyq/INCLUDE/` | Supplied matching release headers; notices/docs stay with those inputs |
| `library-input/` | Authoritative ELF/ar library targets and other supplied originals |
| `lib/` | Trackable selected library targets or conversion/extraction results, depending on configuration |
| `build/` | Ignored compilation/traces/dependency caches plus durable project research records |
| `tools/resource-parsers/` | Project-authored plugins/tests and `parser-plugins.ts`, not copied runtime code |

Fresh scaffolding does not need a second SDK copy under `include/psyq/`.
Explicitly configured existing paths are retained. No SDK input is downloaded,
distributed, or silently obtained from the package's historical reference tree.

The package supplies its own JavaScript runtime dependencies. Public m2c,
maspsx and signature sources are prepared at pinned revisions in
`build/dependencies/`; missing pins are acquired automatically there. Use
`psx_prepare_tooling` to verify/prepare patched m2c. Source hashes are checked;
patching never writes into installed sources. Default supported GCC is built
on demand with the bundled Docker/BuildKit recipe into the runtime cache;
custom compiler executables remain explicit configuration. Supply/configure
cross-binutils, Python, splat/spimdisasm and required Python modules. Missing
external capabilities are reported, not claimed ready.

Original PSY-Q LIB/LNK conversion requires a separately supplied converter,
configured as `tools.psyq2elf`. Supported first-time extraction converts both
unique and colliding members into `lib/`, retaining original/member/converter
hashes. Different existing results are never overwritten silently. An ELF
member match does not prove identity with the original LNK encoding. Library
selection is explicit in `project.json`; never select both an archive and its
extracted copies or infer target kind from the existence of `lib/`.

## Safety, updates and workers

Bootstrap is additive and race-checked. It refuses unsafe symlink destinations
and conflicting mode changes, with no force overwrite. Cancellation may leave
an additive partial scaffold; re-running fills missing files. It never deletes
inputs/lib contents, initializes consumer Git repositories/submodules, commits,
or changes AGENTS.md. Older copied runtimes are not automatically migrated or
removed.

Updating/reinstalling the Pi package updates implementation, not project data.
Preparation validity uses semantic inputs and component compatibility; durable
ledger rows, preserved sources, closures and evidence remain accessible. Clean
operations remove known derived outputs, not research history.

Workers use the same installed implementation with separate project/runtime
contexts. Only declared immutable parent inputs are shared; extraction/build
outputs and `lib/` stay private. Per-TU overrides remain agent-owned `.mk`
entries with directly preceding evidence comments and matching source-policy
allowlist entries in the same patch, integrated through the existing worker
mechanism.

After supplying inputs, run `/skill:psx-identify-project`. Defaults are candidates,
not detected SDK/compiler facts. `psx_verify_build` checks executable bytes only
at 120 seconds; `psx_finalize_function` performs the exact/function, all-container
build, scope and source-policy gate at 300 seconds for its build step.
