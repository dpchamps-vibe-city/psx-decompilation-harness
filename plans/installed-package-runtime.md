# Installed PSX package runtime: implementation plan

Status: proposed implementation plan; no implementation changes are authorized by
this document alone. This plan records the user's requested architecture and
policy direction. Its scope is the harness, not migration of the existing game.

The user's behavioral-parity amendment supersedes conflicting earlier proposals:
provided tools are the agent interface; Milestone D uses today's `.mk`/allowlist
idiom; verification scope, timeouts and performance must match today's Make
behavior. The previous package-runner and override-evidence-system proposals are
withdrawn, not alternate implementation options.

## Decisions and scope

**AGENTS.md is strictly off-limits.** The authoritative protected baseline is
`../btn-decompilation` commit `fdedbe9f68cce6de7a5811e7b05ff32fd74bf601`.
Do not edit, rewrite, replace, restore or regenerate AGENTS.md, or introduce an
indirect substitute. Bootstrap must not author or install a replacement.

The re-review lifts the instruction freeze only for stale commands, paths or
mutation boundaries that this plan removes or moves, plus its explicitly required
baseline restorations. Replace only the affected text; surrounding bytes stay
identical, with no rewording, new guidance or reflow. The instruction-change
contract below defines the permitted edits and their record/tests. Harness
AGENTS.md remains off-limits; its routes still resolve inside the harness checkout.
This plan update itself changes no instruction files.

**`prompts/legacy/` is intentionally absent and must remain absent.** Exclude it
from the required baseline paths. Do not restore, package or reactivate legacy
prompts simply because they existed in the reference commit.

Before implementation, compare the protected active paths against that exact
commit read-only, including missing required active files but excluding the
intentionally removed legacy tree. Do not silently bless the current harness's
contents as the baseline: an audit found existing differences. Report any
mismatch; use the exact baseline and recorded permitted substitutions, not a
silently changed baseline. Restore the non-tooling instruction divergence as
explicitly required below. AGENTS.md is never an implementation edit target.

1. **Run the harness directly from the Pi-installed package.** Finish the
   project-root boundary instead of making copy-into-project scaffolding the
   permanent runtime. Do not build a copied-tool upgrade system as a second
   product architecture.
2. **Existing-game migration is out of scope.** Do not import the live game's
   Makefile, its 22 overrides, its overlay profiles, headers or SDK objects. Do
   not modify the sibling game repository.
3. **Preserve today's agent loop and flag-override idiom.** The agent edits
   `configs/flag_overrides.mk`, its directly preceding evidence comment and the
   matching `.pi/autoloop.json` allowlist entry together. No human approval,
   approval queue, separate bookkeeping step or new evidence-record system.
   Preserve today's evidence bar, source-policy scope and worker integration.
   Agent operations are exposed through provided tools, not a new runner CLI.
4. **`lib/` is project-owned and trackable.** Remove the blanket `/lib/` ignore
   from the harness and generated ignore rules. It is not universally a cache.
   Supplied PSY-Q/other library and SDK inputs belong in `library-input/`, not
   in the installed harness's `tools/` tree.
5. **Fix the obvious bugs from the review**, including the consumer Pi pin,
   duplicate grouping parser, leftover Make calls, failed byte-verification
   exit status, and assumptions that worktrees contain copied harness tools.
6. **Real-game regression-test migration is out of scope.** Do not port the
   static-chain census, audit the game's complete functions.h, or regenerate
   its globals.h as part of this work. Focused synthetic/runtime tests are still
   required for the implementation being changed.
7. **Verification behavior and performance must match today.**
   `psx_verify_build` checks the executable only, with a 120 s timeout; finalize
   checks all containers, with a 300 s timeout. Match today's bytes and verdicts,
   and do not exceed today's equivalent Make/tool timings beyond measured
   three-run noise. Do not increase timeouts to hide a regression. Milestone E
   includes the agent-loop hot path, disposable-clone baseline and required
   performance repairs.

## Instruction-change contract

### I1. Replace only references made stale by tooling changes

Sweep skills, reference sheets, autoloop prompt text and agent-facing tool
descriptions for Make targets, `npx tsx`, tools/ paths and .pi/ paths. For each
reference, determine whether it is an invocation, package-resource link or
project mutation boundary. Keep legitimate project-owned paths. Do not edit
AGENTS.md, historical notes or surrounding instructional prose.

Known replacements, with locations referenced to fdedbe9f:

| Location | Stale reference | Required replacement |
| --- | --- | --- |
| .pi/skills/psx-prepare-function/SKILL.md:38 | `npx tsx tools/build/classifyGlobals.ts --write` | Provided operation that performs classification; add a B3 narrow typed tool if none exists |
| prompts/reference/declarations.md:50 | `tools/build/deriveTuOwnedGlobals.ts <function>` | Provided tool equivalent |
| prompts/reference/stuck.md:24 | `make split` | Provided split operation |
| prompts/reference/population.md:494 | `make check` | Provided verification/finalize tool with the required scope |
| .pi/extensions/psx-decomp/autoloop/prompts.ts:180 | `npx tsx tools/build/deriveRodataSplits.ts …` | Provided operation performing the internal rodata work |
| .pi/skills/psx-build-resource-parser/SKILL.md:18,20 | `tools/agent/resource-extraction/parsers/`, `parser-plugins.ts` | C4's project-owned plugin directory and registry |
| .pi/skills/psx-decompile-function/SKILL.md:380 | `tools/agent/pipeline-reversal/README.md` | Skill-relative link into the installed package |

Complete the sweep beyond these examples. Implement/verify each provided tool
before substituting its name, and change only the stale command, path or boundary.
Use skill-relative links for installed package resources, tested from the actual
installed skill location. No shims, aliases or bash interception for obsolete
spellings; fix the instruction text.

Record every instruction/tool-description edit in
plans/installed-package-runtime-implementation.md as file:line, exact old text,
exact new text, and the tool change forcing it. Identify baseline restorations
separately with their required baseline span and I2 justification. The record is
an exact patch ledger, not permission for extra edits.

### I2. Restore the authoritative text; do not rewrite it

- Restore prompts/reference/flags.md:32–40 verbatim from
  fdedbe9f68cce6de7a5811e7b05ff32fd74bf601. Those lines already describe the
  `.mk` idiom. Replace the harness's fileFlags/human-review wording with the
  original bytes, not a newly worded explanation.
- Revert .pi/skills/psx-decompile-function/SKILL.md:146's non-tooling addition
  about not rereading a sheet already loaded in OBSERVE to fdedbe9f's text.
- Keep that skill's fdedbe9f lines 253–258. If configured compiler-source behavior
  makes a clause false, replace only that clause, e.g. "the exact patched compiler
  tree cc1 is built from" with "the configured compiler source". Preserve the
  remainder byte-for-byte, and drop the added sentences rather than rewrite them.
- Apply the same baseline-plus-minimal-tooling-substitution rule to agent-facing
  tool descriptions in .pi/extensions/psx-decomp/tools/diagnostics.ts.

### I3. Installed-consumer and byte-preservation gates

- Add a test over active instructions and agent-facing tool descriptions/output
  in a clean installed consumer. It fails on a named Make target, project-relative
  tool path or .pi/skills/ path that does not exist there. Validate resource links
  relative to installed skill files and project mutation paths in their prepared
  consumer workflow, not relative to the harness developer's checkout.
- Check that named provided tools/parameters are actually registered and that
  installed package links resolve. Include negative fixtures for each stale
  reference class, rather than relying only on a passing source grep.
- Compare active instructions against fdedbe9f with only the exact I1/I2 recorded
  edits applied. Every unrecorded byte difference, including prose/reflow, fails.
  Baseline restorations must reproduce the original bytes. prompts/legacy/ stays
  absent and excluded; AGENTS.md is unchanged, not an edit target.

## Intended user experience

```text
pi install --local <reviewed package source>
pi
/skill:psx-bootstrap-project          # exe by default
/skill:psx-bootstrap-project library  # library target
```

Pi owns the package declaration in `.pi/settings.json`. Package installation
provides the extensions, skills and implementation. Bootstrap creates the target
project's directories and configuration, prepares supported tooling, and tells
users which inputs/tools are missing and exactly where to supply them.

Bootstrap must not copy the harness's `tools/` implementation tree, extensions/
skills, vendor trees or reference sheets into the target repository. Provided
Pi tools invoke the installed implementation with explicit project context;
agents need no new command syntax or project-local tool copies. Existing
human-facing npm tasks may delegate to installed implementation without becoming
an agent-facing runner. Updating the installed package updates implementation;
project configuration, sources, inputs and experiment history remain owned by
the project and untouched.

The project layout is:

```text
.pi/settings.json     Pi package declaration
.pi/autoloop.json     project loop configuration
include/              project/platform source headers and declaration roles
configs/              target configuration, flag_overrides.mk and project metadata
src/                  reconstructed project sources
extracted/            original extracted game inputs
library-input/        supplied original libraries/SDKs, including their headers
lib/                  project library members/objects or extraction/conversion results
build/                ignored traces, compilation outputs and runtime caches
```

`library-input/psyq/` can contain a supplied release's `LIB/`, `INCLUDE/` and
notices/docs. Those are user inputs even though the harness consumes them.
Reference SDK paths come from project configuration. Existing `include/psyq/`
content is preserved, but fresh scaffolding must not require a second supplied
SDK copy there or obtain headers from retained harness reference assets.

Two uses of `lib/` must work:

- **Library reconstruction:** configured library members/converted objects may
  be authoritative comparison inputs under `lib/`; reconstructed C stays in
  `src/`. Do not overwrite the originals while compiling candidates.
- **Game reconstruction/extraction:** supported extraction/conversion writes
  project library objects/members into `lib/`, with original SDK/library inputs
  retained under `library-input/` and provenance recorded.

Do not infer the target kind from the presence of a library directory. Do not
select an archive and its extracted member copies as duplicate targets. Neither
use justifies ignoring all of `lib/` or treating it as installed-package data.

## Milestone A — immediate, independent repairs

These fixes can land before the larger runtime refactor.

### A1. Correct input ownership and ignores

Files: `.gitignore`, `tools/build/scaffoldProject.ts`,
`templates/project/toolchain.json`, bootstrap setup code, non-prompt documentation
and associated tests. Instruction edits are permitted only under I1 for a
command/path/mutation boundary actually moved by this work; no prose rewrites.

- Remove `/lib/` from both repository and scaffold-managed ignore rules. Do not
  replace it with an equivalent blanket `*.o`/`*.a` rule that hides lib contents.
- Retain appropriate ignores for `build/`, `extracted/`, `library-input/`, Pi's
  package caches and other actual runtime outputs.
- Keep original SDK/library defaults under `library-input/`; move fresh SDK
  header-reference defaults there too. Preserve explicitly configured paths.
- Never delete existing user inputs or lib contents during bootstrap/cleanup.
- Update the supply checklist to distinguish original inputs, project lib
  contents and disposable build outputs.

Acceptance: git check-ignore shows `lib/member.o` and `lib/library.a` are
trackable, while build outputs and supplied raw-input directories remain
ignored. Bootstrap preserves pre-existing lib/input files byte-for-byte.

### A2. Remove consumer dependency leakage

Files: `package.json`, bootstrap's package merge and dependency/install tests.

- Keep Pi core packages and typebox as package peer dependencies with `"*"`.
- Remove the bootstrap merge of all development dependencies into consumer
  production dependencies. It currently emits Pi 0.83.0 despite the corrected
  harness manifest.
- Use explicit dependency lists for any remaining project-owned capability;
  never copy development test pins into user projects.
- The final external runtime should use its own installed tsx/TypeScript and
  other runtime dependencies, not require their duplication in the consumer.
- Exercise installation/extension loading with Pi 0.85.1. Do not confuse a test
  dependency pin with the running user's Pi version.

Acceptance: a production-only package install and a bootstrapped consumer do
not acquire a regular Pi 0.83.0 dependency from scaffolding. Runtime peers resolve
through the supported Pi host/package flow.

### A3. Use one grouping parser

Files: `.pi/extensions/psx-decomp/autoloop/family.ts`,
`tools/agent/fileGroupings.ts`, focused parser tests.

- Replace family.ts's private grouping parser with the shared reader/siblings
  helper, passing the project's ledger path explicitly.
- Retain annotated `(m, matched ...)`, plain `(m)`, `(s)` and `(?)` entries while
  excluding prose bullets and respecting group boundaries.
- Do not import any game's ledger into the package.

Acceptance: all consumers return the same siblings for a small fixture covering
those status spellings. No fixed membership count from a live game is needed.

### A4. Remove operational Make dependencies

Files: `tools/agent/diffFunc.ts`, provided build operations and affected tests.
Replace stale instruction command references only under I1; preserve all other
reference-sheet bytes.

- Replace verifyLinkedBytes's Make invocation with the shared configured build
  API. Use the function's actual container and project context.
- Propagate requested byte-verification failure/unavailability to a nonzero
  exit status. Do not claim success or read a stale artifact after build failure.
- Keep library whole-member and linked-image verification claims distinct.
- Replace obsolete Make invocations in agent-facing instructions with the
  provided operation under I1. Provided tools/internal callers invoke the same
  installed build API; no shims, aliases, bash interception or second build
  implementation compensate for stale instruction spellings.

Acceptance: --bytes succeeds only on the requested successful comparison;
failed build, unavailable verification and differing linked bytes fail. The
production route has no Makefile dependency.

## Milestone B — explicit package/project/runtime context

Add the shared context in `tools/lib/` and make it the dependency of all
production target operations. The exact TypeScript API should express:

```text
harnessRoot   installed implementation and bundled, pinned support assets
projectRoot   current target's configuration, sources and project inputs
runtimeRoot   current project's/workspace's generated outputs and caches
```

Worktree contexts additionally identify the parent project's explicitly shared
immutable input locations. This must be a declared relationship, not a generic
permission to follow arbitrary symlinks outside a project.

### B1. Introduce resolvers with explicit ownership

- Discover the target from the requested project path or Pi `ctx.cwd` and its
  configuration, not from the presence of AGENTS.md plus tools/agent.
- Reserve import.meta.url-derived roots for installed code/support assets.
- Resolve relative project include/input/output/configuration paths against
  projectRoot. Resolve bundled assets against harnessRoot. Resolve configured
  external executables as configured, preserving argv boundaries.
- Represent path origins explicitly where toolchain settings currently mix
  bundled compiler sources/scripts with project SDK/input paths. Update their
  schemas, templates and readers together; do not guess by trying both roots.
- Never fall back to an installed package's target/configuration files, a
  sibling game's checkout, or a previous project's cached state.
- Default standalone CLI discovery may start at cwd, but the discovered context
  must then be passed explicitly. Do not ship a process.cwd/chdir/environment
  substitution as a replacement for this boundary.

### B2. Thread context through the production graph

Start with `tools/lib/toolchain.ts`, `psxExeInfo.ts`, `project.ts`, container and
profile loaders, then `tools/agent/decompToolchain.ts` and the build pipeline.
Continue through their diagnostic/matching/resource callers and extension
helpers.

Audit all module-level ROOT/path constants, eager target loads, URL-relative
file access, shell command strings and subprocess working directories. Each
operation must distinguish package implementation paths from target paths.

- Subprocesses execute installed scripts with absolute implementation paths,
  explicit project context and the correct project cwd.
- Configurations, target data, recovered C and generated artifacts are never
  searched for relative to the installed tool source.
- Separate durable research history from disposable derived caches. Scope
  cache storage to the project/workspace, and validity to the relevant inputs
  and producing component's compatibility contract, not blanket package identity.
  Configuration edits and project switches must not reuse stale results, but an
  unrelated package update must not discard valid preparation packets.
- Compiler instrumentation, patched m2c trees and prepared build sources write
  to the declared runtime/dependency cache, not to installed source trees.
- Bundled public vendor sources remain package support assets. Missing pinned
  tooling is provisioned automatically into a suitable dependency cache, not
  into the consumer's tools tree. Proprietary SDK inputs are never downloaded.

Use an inventory/check to ensure no production entrypoint still derives its
target root from its own module location. Temporary adapters may aid conversion,
but a hidden package-root target fallback is not an acceptable end state.

#### B2 cache/history contract

Inventory persisted artifacts and classify them before changing their keys:

- **Durable history:** experiment-ledger rows, sources, measurements, closures
  and evidence are append-only project records, not a cache to invalidate.
  Preserve their contents and accessibility across updates; do not delete,
  overwrite or silently retire them because the package version changed.
- **Comparison identity:** define stable domains from the original target,
  source/context inputs, relevant compiler/assembler identities and flags, and
  the residual interpretation/schema. Record compiled-output fingerprints
  independently of the package release. Equal output under compatible domains
  must still compare equal across upgrades and worktrees. Package version,
  commit, install path and producer provenance may be recorded, but must not
  salt that equality. An incompatible interpretation must be explicitly named,
  not presented as a newly different experiment.
- **Derived artifacts:** key preparation packets and other caches by the
  inputs they actually consume and a component-scoped algorithm/schema
  compatibility identifier. Compiler, target, header or applicable flag changes
  invalidate affected artifacts and dependents; changes to an unrelated tool,
  documentation, command formatter or package location do not. Use measured
  dependency fingerprints where needed, not a hash of the entire harness or
  toolchain configuration as a universal invalidator.

Retain readers for existing ledger rows and compatible packet formats. Where
older rows include release-salted keys, derive a comparison index/adapter from
available semantic inputs and output fingerprints without rewriting history.
If old evidence cannot establish compatibility, report that limit explicitly;
never equate incompatible measurements or discard the original records.

Acceptance: measure a synthetic project, update/reinstall the package at a new
location with an unrelated tool change, then measure it again. Compatible
preparation packets remain usable, previous ledger rows remain visible and
unchanged, and equal compiled output is still recognized as equal. A change to
one producing component invalidates only its affected artifacts/dependents;
changed target/compiler/flags cannot reuse stale evidence.

### B3. Use provided tools as the agent interface

- Preserve the provided Pi tool names, typed parameters and workflow. Their
  handlers resolve the installed implementation and pass explicit project
  context. Agents must not learn or invoke a package-runner primitive.
- Interactive commands, autonomous workers and existing human CLI/npm tasks
  use the same internal APIs/context. Dispatch and subprocess details stay
  inside implementation, not in agent instructions or an agent-facing CLI.
- Resolve package identity/location from supported Pi installation/resource
  provenance, rather than guessing `.pi/git/` internals or persisting a
  developer's absolute checkout path as a portable project setting.
- Verify provided tools after package update/reinstallation and from a fresh
  trusted checkout. Inspect the host's supported package-resolution interfaces;
  do not invent a Pi API or make a generic command executor the new interface.

#### B3 agent-facing hints and coverage

Inventory runtime-emitted usage/error/next-step hints, including the review's
77+ `npx tsx tools/...` occurrences. Agent-facing follow-ups must name provided
tools and their parameters, not paths agents should execute through bash.

- Use `psx_residual_objective` for candidate measurements and
  `psx_finalize_function` for the terminal exact/build/policy gate; do not
  introduce a raw diffFunc tool or a runner alias as a competing workflow.
- Direct mechanism work to the corresponding provided tools, such as
  `psx_fuzz_variants` and `psx_search_scheduler_state`. Build internals such as
  deriveRodataSplits remain implementation details, performed by the relevant
  build/preparation operation rather than handed to the agent as shell commands.
- If an agent-required operation genuinely lacks tool coverage, expose it as
  a narrow typed tool, not a generic script-name/argv execution tool. Preserve
  intentional exclusions of human maintenance and internal build commands.
- Centralize agent-facing hint formatting and test that suggested tool names
  and parameters exist in the installed registration. Human CLI help may retain
  its CLI syntax, but it must not leak missing-project-path recommendations into
  provided-tool output.
- Apply I1's minimal replacements to stale command/path/boundary references in
  active instructions; never advertise a runner or broadly rewrite the workflow.
  Historical notes remain untouched. Existing manual CLIs may remain for humans/
  internal callers, but no shims, aliases or bash interception preserve obsolete
  agent spellings. Do not require a global tsx, network fetch or copied harness
  tools for provided-tool calls.

Acceptance: agents invoke the provided tools in a clean production-only consumer
and Git worktree, before and after a package update. Tool follow-ups reference
registered tools with valid parameters; no runner syntax or project-local script
invocation is needed. Internal calls preserve argv, failure propagation and
verification semantics without copied implementation or target-root fallbacks.

Acceptance for B: two unrelated synthetic EXE/library projects can use the same
installed harness, including same-process project switches and config edits.
Diagnostics/preparation/build helpers use the correct target each time; package
files are unchanged; all artifacts land in the correct project/runtime.

## Milestone C — external-runtime bootstrap and worktrees

### C1. Replace source-snapshot scaffolding

Files: package Pi manifest, bootstrap extension implementation, scaffold code,
configuration templates and documentation. Instruction changes are limited to
I1/I2's recorded substitutions/restorations; AGENTS.md is never an edit target.

- Expose the matching/resource extensions and workflow skills from the installed
  package, not only onboarding. Before configuration exists, tools should give
  the bootstrap/setup instruction rather than assuming a target exists.
- Scaffold only project-owned directories, headers, configuration, loop settings
  and a README/existing npm-task delegation as required. Do not add an
  agent-facing runner or tools/agent shim tree.
- Create configs/flag_overrides.mk with only its format header when absent.
  Never modify an existing override file.
- Remove implementation/vendor/reference-sheet copying and source-snapshot
  markers/ESM boundaries that existed only to support the copied runtime.
- Replace only skill commands/links/mutation boundaries made stale by the
  installed runtime, following I1. Preserve surrounding bytes and resolve the
  selected target without compatibility shims or injected substitute prompts.
- Preserve existing source/configuration/header/input files and unrelated npm
  tasks. Leave Pi's package declaration to Pi. Never create, copy, update or
  replace AGENTS.md as part of scaffolding.
- No automatic removal of older copied tools from existing projects. Migrating
  already-scaffolded repositories is outside this plan's migration scope.

### C2. Complete library-input/lib wiring

Files: toolchain/target configuration, SDK conversion/extraction entrypoints,
header-reference resolution and bootstrap handoff.

- Inventory supplied releases under library-input and use the configured
  originals, headers and notices. Retained tools/vendor/psyq47 must not become
  the active default or a fallback when the user has supplied nothing.
- Route supported extraction/conversion to the project's lib directory. Use
  the existing converter contract for both colliding and non-colliding members;
  do not leave first-time extraction dependent on pre-bundled converted objects.
- Preserve original hashes and converter/member provenance. Preserve existing
  verified results; do not overwrite different files silently.
- Select original supported ELF/ar targets or explicit converted member targets
  according to configuration. A converted-object match is not a claim about
  original PSY-Q LNK encoding. New format/original-LNK oracle work is not required.
- Treat lib's role as mode/configuration-dependent, not intrinsically immutable
  or intrinsically disposable.

Acceptance: tiny synthetic library and SDK fixtures exercise library target
selection and extraction into a trackable lib directory; both use originals
from library-input rather than the package's reference SDK tree.

### C3. Make worktrees independent of copied tools

Files: `.pi/extensions/shared/workspace.ts`, autonomous command/process helpers
and project/runtime context derivation.

- Preserve the installed harness identity while changing projectRoot/runtimeRoot
  to the worker workspace. Provided tools/internal APIs invoke installed splitting,
  preparation, diagnostics and verification without a new agent command.
- Do not require tools/build/pipeline.ts or harness vendor sources in worker HEAD.
  This removes the copied-pipeline/legacy-tools-ignore failure structurally.
- Make configured original game/library/SDK/header inputs available in workers.
  Share only declared immutable inputs; retain isolated writable extraction/build
  outputs. Do not blindly symlink lib if the selected workflow will write there.
- Carry project-owned source, configs/flag_overrides.mk and .pi/autoloop.json
  changes through today's baseline/patch integration mechanism. Do not replace
  it with toolchain.json flag changes or a separate evidence-record channel.
- Do not initialize unrelated consumer submodules to obtain installed tools.

Acceptance: create a real synthetic Git worktree whose HEAD contains no copied
harness tools. It can access its declared game/library/SDK inputs and run package
split/preparation paths without writing into the installed package or another
workspace.

### C4. Preserve project-owned resource parser development

The current resource builder edits tools/agent/resource-extraction/parsers and
parser-plugins.ts. Once those paths live in the package, they cannot remain its
project-mutation boundary.

- Keep built-in parser implementations/registry in the package.
- Put project-authored plugins/tests in tools/resource-parsers/, with the
  project-owned registry at tools/resource-parsers/parser-plugins.ts. This is
  authored project tooling, not a copied harness runtime. Bootstrap/preparation
  creates missing directories and an empty project registry without overwriting
  existing plugins or registry content.
- Update only the resource-builder skill's stale plugin/registry mutation paths
  under I1 to those C4 locations; keep surrounding instruction bytes unchanged.
- Update plugin discovery, preparation baselines, source-policy paths and test
  runners to use that project location and the explicit context.
- Loading/accepting a project parser must not patch the installed package.

Acceptance: a synthetic project plugin is discovered, tested and used from the
installed runtime; the package registry and implementation remain unchanged.

## Milestone D — parity with today's per-file flag overrides

This replaces the previous Milestone D completely. Reference behavior is today's
btn-decompilation configs/flag_overrides.mk, source-policy.ts:432–452 and
:524–545, and its compile readers. AGENTS.md remains off-limits.

### D1. One project-owned source of truth and one shared reader

- Overrides live only in configs/flag_overrides.mk. Each entry is one line:
  `CC1FLAGS_<stem> := <extra cc1 flags>`, with a `#` evidence comment directly
  above it. The stem is the source basename without `.c`; a library TU uses
  its member ID.
- Preserve today's read pattern `^CC1FLAGS_(\S+)\s*:=\s*(.+)$` and policy
  pattern `^CC1FLAGS_(\S+?)\s*:?=`. Do not execute Make or shell-expand the file
  to read it, or invent a different override grammar. Reject every non-blank,
  non-comment line that fails the read pattern, reporting file and line; never
  silently drop an unrecognized assignment/directive after removing Make.
  Blank lines and comments are allowed. All 22 current btn entries conform.
  Test valid entries and malformed/unsupported non-comment lines across callers.
- Implement one shared reader with explicit project context. Use it in the build
  pipeline and every diagnostic/preparation compile: decompToolchain equivalents,
  diffFunc, flagProbe, loopTrace and its cache key, triage, the residual objective
  and preparation. Remove duplicate ad hoc readers.
- Effective cc1 argv is the TU's effective base flags, including its container
  profile, followed by its override flags. Match today's Makefile FlagsSwitch
  ordering; compare the actual argv across every compile route.
- Remove toolchain.json.fileFlags, or refuse any configuration setting it.
  Remove the channel from schemas, defaults, templates, readers and policy logic;
  it must not silently merge with, override or replace the `.mk` file.
- Include applicable effective flags in derived-cache/measurement identities.
  Changing one TU's override must not invalidate unrelated TU preparation or
  destroy historical ledger comparisons.

### D2. Preserve today's authorization and integration

- Each added or changed CC1FLAGS_ line requires a `flag-override` entry in
  .pi/autoloop.json sourcePolicy.allowlist, keyed by function name or
  `<container>:<address>` for overlays. Resolve the line's stem, not an empty or
  unrelated patch scope, for the existing allowlist lookup.
- Finalize checks only the function being finalized, or the source names actually
  scanned. It is never an audit of every existing override in the repository.
  Pre-existing un-allowlisted lines cannot block unrelated changes; new/changed
  lines in the patch still require their own authorization.
- The agent itself adds the override, directly preceding evidence comment and
  allowlist entry in the same change. No human approval, approval queue,
  automatically substituted authorization, evidence-record system or separate
  bookkeeping step.
- Worker integration carries configs/flag_overrides.mk and .pi/autoloop.json
  changes exactly as today. Do not relax unrelated toolchain/target configuration
  protections to implement flag changes.
- Port today's flag-override source-policy tests unchanged. Keep ordinary source
  restrictions and verification protections intact; this is not authorization
  for assembly or register pinning.

### D3. Agent-facing text and bootstrap

- psx_flag_probe proposes `.mk` override lines, with evidence comments and the
  corresponding allowlist idiom, not toolchain.json edits or human-review advice.
- Restore prompts/reference/flags.md:32–40 verbatim from fdedbe9f as required
  by I2; do not author a replacement paragraph. Other instruction/description
  edits follow I1/I2's exact baseline-and-substitution rule. AGENTS.md is untouched.
- Bootstrap may create configs/flag_overrides.mk containing only its format
  header when the file is absent. It never modifies an existing file.
- Do not audit, approve or migrate the live game's pending entries here.

Acceptance, on synthetic projects:

1. Adding override, evidence comment and allowlist entry together passes the
   source-policy gate and integrates through the existing worker path.
2. The same change without its allowlist entry fails.
3. An unrelated change with a pre-existing un-allowlisted override passes.
4. For a TU with an override, build and every diagnostic/preparation compile
   have identical effective cc1 argv: container-effective base + override.
5. Today's flag-override source-policy tests pass unchanged.
6. The shared reader rejects malformed non-comment lines with file/line errors;
   build and diagnostics fail rather than compiling with silently omitted flags.

## Milestone E — verification and build-performance parity

Reference behavior is today's btn-decompilation verify-build.ts and gates.ts:158,
plus its Make build graph. This replaces the former performance exclusion.

### E1. Preserve results, scope and timeouts

- Build outputs are byte-identical to today's, with identical pass/fail verdicts.
  Retain complete comparisons and fail on unavailable/stale build outputs.
- psx_verify_build checks the executable only, equivalent to today's
  `make check`, with a 120 s timeout.
- Finalize's build gate checks all containers, equivalent to today's
  `make check-all`, with a 300 s timeout. Do not substitute executable-only or
  edited-container verification for this gate.
- Do not increase either timeout to absorb a performance regression. Tool
  descriptions and reported verification scope must match the operation run.
- Match check side effects and ordering, not only bytes. After the executable
  byte check passes, regenerate configs/project-profile.md as today's
  Makefile:224 does; do not refresh it on a failed executable comparison.
- check-all performs its per-container checks with SKIP_RODATA_CHECK, then runs
  deriveRodataSplits --all once, matching Makefile:327–330. Preserve the EXE
  check's profile refresh in that sequence. This verification-phase rule does
  not remove rodata work the baseline build itself requires.
- Test successful/failed profile refresh sequencing and the one all-container
  rodata invocation with per-container verification rodata checks skipped.

### E2. Measure today's baseline without changing the game checkout

- Record btn-decompilation's current HEAD at measurement time. This performance
  baseline is distinct from the protected prompt baseline commit.
- Make a disposable clone at that HEAD with extracted/ symlinked to the original
  inputs. Do not modify btn-decompilation itself or write through that symlink.
- Use separate disposable comparison workspaces for baseline Make/tools and the
  installed harness, with equivalent source/input/toolchain/profile/override
  state. Exercise the harness against clone project data; do not migrate the live
  game or import its assets/configuration into the harness repository.
- Before any Pi-driven harness measurement, remove btn's own .pi/extensions,
  .pi/skills and tools/ from the harness-side clone only. Retain them in the
  baseline clone. Otherwise both extensions load and the first registered tool
  name wins silently. Verify the registered tools' implementation provenance
  and fail duplicate registration; measurements must use the intended copy.
- Give the harness clone a translated toolchain.json matching Makefile:43–46.
  The overlay profile replaces cc1/as small-data flags with -G0 (EXE retains
  its baseline settings); maspsx flags are unchanged. Keep all per-TU overrides
  in configs/flag_overrides.mk, not in translated JSON.
- Preserve/copy the needed SDK inputs into the harness clone's library-input/
  before deleting its tools/ tree, and configure SDK/library/header paths
  explicitly. Never use tools/vendor/psyq47 as an implicit fallback. Record
  hashes and tool paths so translation, not an unnoticed compiler/input change,
  is being measured.
- Negative controls must fail the byte check when the overlay profile or one
  effective current override is dropped. Rebuild affected artifacts so stale
  caches cannot mask the missing flags; record the observed failure before
  accepting positive results.
- Run each scenario three times for each implementation, under comparable host
  conditions and identical cold/warm starting states. Record all wall times,
  commands, environment, revision, installed package identity and input hashes.
  State the noise measured from those runs and the comparison rule; do not
  cherry-pick the fastest harness run or widen tolerance to excuse slowness.

Required scenarios:

| Scenario | Baseline operation/state | Harness equivalent |
| --- | --- | --- |
| Cold full run | Empty build/, then split-all, then check-all; time the combined run | Same empty-build split-all + check-all operation |
| Warm no-op | check-all with current artifacts | Same all-container no-op check |
| One EXE source touched | Touch one EXE .c, then check-all | Same touch and all-container check |
| One overlay source touched | Touch one overlay .c, then check-all | Same touch and all-container check |
| Executable only | check with the same starting artifact state | Executable-only verification |
| Finalize hot path | psx_finalize_function end to end on an already-matching function | Same function and complete tool/gate operation |
| Residual objective cold | psx_residual_objective on a fixed candidate, with declared disposable caches cold | Same target/candidate and cold cache state |
| Residual objective warm | Same fixed-candidate tool call with warm caches | Same target/candidate and warm cache state |
| One-function preparation | Today's preparation operation on one fixed function/context | Same function/context and complete preparation operation |

The 2026-10-10 run's roughly 79 min of finalize waits and 25 min of residual
objective waits motivate the hot-path rows; they are not substitutes for current
three-run baselines. Time the complete operation, including tool dispatch,
subprocesses and gate/preparation work, not a cheaper internal microbenchmark.

Reset the declared starting state for every repeat. Cold residual measurements
clear only disposable caches, not ledger history. Record the chosen functions,
fixed candidate, preparation arguments and cold/warm cache definitions so both
implementations measure the same work. Installation/setup is recorded separately
and must not hide work required by the timed cold full run. No task may be slower
than its baseline Make/tool equivalent beyond the stated three-run noise.

### E3. Remove known extra costs, without weakening correctness

- Refresh/revalidate the EXE build at most once per invocation that needs it,
  not once per overlay. Export engine symbols at most once per invocation and
  only when the EXE ELF changed, matching the dependency behavior of
  `$(ENGINE_SYMS): $(wildcard $(BUILT_ELF))`. Preserve cold/missing-output handling
  and never accept stale exports after a failed EXE build.
- Reuse invocation-scoped dependency/freshness results across containers.
  Content-hash checks may remain for correctness, but a no-op run must cost no
  more than Make's timestamp-based no-op within measured noise. Do not trade
  correctness for fast stale-cache acceptance.
- Do not add subprocess launches per container beyond those today's Makefile
  runs. Record process counts/traces when diagnosing excess work, and move
  duplicated work into shared internal APIs or one invocation-level operation.

Acceptance:

- All nine scenarios pass the baseline comparison, with three-run measurements
  and the stated noise shown in plans/installed-package-runtime-timings.md.
  Each harness time is at or below its baseline within that noise.
- Show byte-identity and matching verdicts in the disposable clone, with the
  overlay-profile and override negative controls failing as required.
- Tests confirm executable-only 120 s verification versus all-container 300 s
  finalization, profile-generation side effects, and check-all's skipped
  per-container verification rodata checks plus one final --all operation.
  Include failing-build/mismatch cases, not only successful builds.
- Commit the timing table as requested for implementation acceptance; do not
  commit extracted inputs or generated binary artifacts. This plan-only update
  does not make that future commit or claim unmeasured performance.

## Execution order and completion checks

1. Record E's baseline HEAD, disposable-clone setup and three-run Make/tool
   timings before changing orchestration. Do not modify the sibling game checkout.
2. Land A's isolated correctness fixes with focused tests.
3. Establish B's context/resolvers and convert core loaders/compiler/build paths;
   separate durable history, stable comparison domains and component-scoped caches.
4. Convert production diagnostics, resources and extension commands to installed
   internal APIs; keep provided tools as the agent interface and eliminate
   package-root target fallbacks. Apply D's single `.mk` reader across all compile
   routes as they are converted, so no diagnostic uses different flags.
5. Complete C's bootstrap/input/worktree/plugin wiring; remove implementation
   copying from the new-project path. Preserve D's existing allowlist and worker
   integration behavior. Apply and record only I1's necessary tooling-reference
   edits and I2's baseline restorations, with byte-preservation tests.
6. Complete E's invocation-level build/export/freshness and check-side-effect
   repairs. Prepare the isolated harness clone, validate negative controls,
   measure all nine scenarios over three runs and publish the timing table.
7. Run focused installed-package/worktree/instruction tests and the portable
   harness suite. Report pre-existing typecheck failures separately rather than
   hiding them.
   Verify distribution/install behavior without bundling proprietary SDK/library
   inputs or local compiler builds. Never edit AGENTS.md.

Definition of done:

- Harness AGENTS.md is untouched and its routes resolve inside the harness
  checkout. No shadow instructions or replacement guide are introduced.
- Active instructions/tool descriptions equal
  fdedbe9f68cce6de7a5811e7b05ff32fd74bf601 except for the exact edits recorded
  under I1/I2. Flags lines are restored verbatim; non-tooling decompile divergence
  is reverted, with only a necessary compiler-source clause substitution allowed.
  Surrounding bytes are unchanged. prompts/legacy/ remains absent and excluded.
- The implementation record contains every instruction edit and its tooling
  justification/baseline restoration. Installed-consumer tests reject stale
  Make/tool/skill references; no shims, aliases or bash interception hide them.
- `pi install --local` plus bootstrap works for fresh exe/library projects.
- Implementation/extensions/skills run from the installed package, not copies.
- Projects share package code without sharing target state or writable outputs.
- Package updates preserve durable ledger history and cross-release equality;
  derived-cache invalidation is scoped to affected inputs/components.
- Agent-facing hints name provided tools and valid parameters; tools work in
  consumers/worktrees without a new runner primitive or project-local scripts.
  Historical notes are not rewritten.
- `lib/` is trackable and retains its selected project role; supplied SDK/library
  data is consumed from library-input, not treated as harness implementation.
- Worktrees and project resource plugins work without modifying package code.
- Per-TU overrides use only configs/flag_overrides.mk with evidence comments,
  today's allowlist authorization/scoped checks and existing worker integration.
  Build and every diagnostic/preparation compile use the same base + override argv.
- psx_verify_build is executable-only at 120 s; finalize is all-container at
  300 s. Bytes/verdicts match today's, and the committed three-run timing table
  demonstrates parity for all nine build/agent-loop scenarios without increased
  timeouts. Verification side effects match today's, and both flag-translation
  negative controls fail the byte check.
- No emitted Pi 0.83.0 consumer dependency, lost annotated grouping entries,
  operational Make dependency, or successful exit for failed requested byte
  verification remains.

Not completion requirements: migrating the live game, importing its flags into
the harness, regenerating its live headers, relocating its current SDK/lib assets,
or porting its real-asset test suite. E's disposable-clone byte/performance
comparison is explicitly required; it is not authorization to modify the game.
