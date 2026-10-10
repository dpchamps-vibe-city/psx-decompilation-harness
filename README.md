# PSX Decompilation Harness

Pi-assisted PlayStation matching-decompilation tools, compiler diagnostics,
build generators and resource workflows. Start a project by cloning this repo
(or exporting it with its vendor sources), adding your assets, and configuring
`toolchain.json` and the project metadata.

**Scaffolding in progress.** Supported compiler/SDK defaults are not evidence
about your game. Remaining assumptions are listed in
[docs/game-agnosticity.md](docs/game-agnosticity.md). The tools live inside the
project tree; this is not a separately installed harness CLI.

## Quick start

```sh
npm ci
npm run setup                  # initialize vendors and prepare patched m2c
npm run identify -- --json      # separate target evidence from configured choices
npm run disassemble
npm run split
npm run check-all
npm run progress               # the former make progress command
```

Provision the compiler, cross-binutils and Python tools named in `toolchain.json`.
`setup` does not install those binaries or obtain game assets. A recursive clone
includes vendor sources; degit exports may omit gitlinks. See
[docs/toolchain.md](docs/toolchain.md) for setup, configuration, profiles,
incremental builds and all npm tasks.

In Pi, use `/skill:psx-identify-project` to inspect an unfamiliar project's assets
and create an evidence-backed configuration. Without a target, the shallow
identification report returns `undetermined`; it does not invent game facts.
An explicit-file header diagnostic also works:

```sh
npx tsx tools/diagnostics/headerInfo.ts /path/to/PS-X-EXE /tmp/header-info.md
```

## Layout

| Path | Contents |
| --- | --- |
| `toolchain.json` | Shared tool paths, flags, SDK inputs and explicit profiles |
| `.pi/` | Decompilation/resource extensions and workflow skills |
| `tools/agent/` | Matching, compiler analysis, source search and resource extraction |
| `tools/build/` | npm pipeline, disassembly, SDK integration and build generators |
| `tools/diagnostics/`, `tools/lib/` | Identification, progress, byte oracles and shared utilities |
| `tools/vendor/`, `lib/` | Pinned sources and retained SDK inputs |
| `include/`, `configs/` | Platform support and project scaffolding |
| `examples/btn-decompilation/` | Original project's configuration, headers and build file |
| `notes/` | Tooling inventory only; no inherited game plans or research logs |
| `prompts/`, `test-fixtures/` | Per-pass mechanism sheets, archived templates and regression inputs |

No target executable, extracted disc/archive, recovered C sources, credentials
or autonomous run state is supplied. Historical examples and references grant
no policy exceptions and establish no facts for another game.

## Agent policy and matching guidance

Repository-wide rules live in `AGENTS.md`; active workflows live in `.pi/skills/`.
`psx_reference` serves the per-pass sheets in `prompts/reference/`, selected by
the residual owner rather than loaded wholesale. Historical standalone templates
in `prompts/legacy/` are not active workflows; see [prompts/README.md](prompts/README.md).

Policy exceptions belong in `.pi/autoloop.json` under `sourcePolicy.allowlist`.
Key an entry by function name or `<container>:<address>` because overlays share
RAM. Bare address keys apply only to the executable. This template supplies no
exceptions; adding one is a human decision, not an agent workaround.

## Validation and references

Use narrow checks while scaffolding. `npm test` still includes inherited
real-project tests requiring absent binaries, sources, generated headers and
history; the full suite and strict TypeScript check are not currently green.
Do not fabricate target inputs or suppress unrelated regressions to change that.
The locally provisioned compiler is an ignored artifact, not a distribution.

- [Toolchain configuration and npm tasks](docs/toolchain.md)
- [Migration inventory, pins and measured validation](docs/migration.md)
- [Remaining generalization work](docs/game-agnosticity.md)
- [Agent instructions](AGENTS.md)

Retained third-party assets keep upstream notices. The package license does not
relicense SDK/compiler/signature assets; review redistribution rights before
publishing them.
