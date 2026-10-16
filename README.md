# PSX Decompilation Harness

Pi-assisted PlayStation matching-decompilation tools, compiler diagnostics,
build generators and resource workflows. Install it locally as a Pi package,
then explicitly bootstrap the project:

```sh
pi install --local git:github.com/software-factory-vibe-city/psx-decompilation-harness@REF
pi
```

```text
/skill:psx-bootstrap-project          # defaults to exe
/skill:psx-bootstrap-project library  # ELF/ar library target
```

Replace `REF` with a reviewed commit/tag; `-l` is the short form of `--local`.
Bootstrap creates the project source scaffold, headers, input directories and
ignore rules, then tells you what to supply. It does not fetch assets or compiler
binaries, clear existing inputs, or overwrite project configuration. See
[installation and bootstrap](docs/bootstrap.md) for the full contract.

**Generalization in progress.** Supported compiler/SDK defaults are not evidence
about your game. Remaining assumptions are listed in
[docs/game-agnosticity.md](docs/game-agnosticity.md). Bootstrap creates project-owned
scaffolding; tools run from the installed package with separate project and runtime
roots. Cloning/exporting this repo is also supported.

## Clone/development quick start

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
Target adapters support linked images and ELF/ar members through the same
matching tools and skills. `project.json` selects library assets; without it,
the EXE/overlay configuration applies. See [target configuration](docs/library-targets.md)
and `examples/library/project.json`. Generate the agent-facing profile with
`npm run profile -- --write` after configuring either format.

An explicit-file header diagnostic also works:

```sh
npx tsx tools/diagnostics/headerInfo.ts /path/to/PS-X-EXE /tmp/header-info.md
```

## Layout

| Path | Contents |
| --- | --- |
| `toolchain.json` | Shared tool paths, flags, SDK inputs and explicit profiles |
| `project.json` (optional) | Target assets, header roles and owner profiles |
| `.pi/` | Decompilation/resource extensions and workflow skills |
| `tools/agent/` | Matching, compiler analysis, source search and resource extraction |
| `tools/build/` | npm pipeline, disassembly, SDK integration and build generators |
| `tools/diagnostics/`, `tools/lib/` | Identification, progress, byte oracles and shared utilities |
| `tools/vendor/` | Pinned sources and retained reference inputs (SDK rights still need review) |
| `extracted/`, `library-input/` | Ignored local game and original-library inputs; created by bootstrap |
| `lib/` | Trackable selected library targets or converted ELF inputs; not bundled with the package |
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
the residual owner rather than loaded wholesale. The per-pass sheets in `prompts/reference/` are served by `psx_reference`
and loaded individually when the pipeline reversal names the owning pass.

Policy exceptions belong in `.pi/autoloop.json` under `sourcePolicy.allowlist`.
Key an entry by function name or `<container>:<address>` because overlays share
RAM. Bare address keys apply only to the executable. This template supplies no
exceptions; adding one is a human decision, not an agent workaround.
Library TU exceptions use the member ID, not invented addresses or one symbol's
approval borrowed by its neighbors.

**Shared operation macros do not require per-macro human approval.** Agents may
create project include-file macros with strong SDK/original-code evidence and
unchanged-production byte verification. Exceptional definitions use the automatic
`configs/macro-evidence.json` gate, not the function allowlist. Inspectable C
helpers need no manifest. See [evidence-backed macros](docs/macro-evidence.md)
for the proof requirements, fingerprint command and verification workflow.

The read-only [handwritten-assembly scanner](docs/handwritten-assembly.md) ranks
original-word ABI/context evidence across images and library members. It reports
advisory candidates with configurable thresholds, protects existing C and emits
no assembly or policy exemptions. A member the oracle then verifies from one
`.s` source is an assembly translation unit; the same document describes the
process from classification to annotated source.

## Validation and references

`npm test` passes without BTN assets using [isolated fixtures](test-fixtures/harness/README.md)
and the provisioned tools from `toolchain.json`. Optional historical original-asset
tests remain guarded and skipped without their inputs; strict TypeScript checking
still has inherited errors. Fixture checks do not establish target-byte identity.
The locally provisioned compiler is an ignored artifact, not a distribution.

- [Install and bootstrap a project](docs/bootstrap.md)
- [Toolchain configuration and npm tasks](docs/toolchain.md)
- [Library targets and verification scope](docs/library-targets.md)
- [Handwritten-assembly heuristics](docs/handwritten-assembly.md)
- [Migration inventory, pins and measured validation](docs/migration.md)
- [Remaining generalization work](docs/game-agnosticity.md)
- [Agent instructions](AGENTS.md)

Retained third-party assets keep upstream notices. The package license does not
relicense SDK/compiler/signature assets; review redistribution rights before
publishing them.
