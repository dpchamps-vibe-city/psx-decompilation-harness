# Installed package runtime — implementation record

## Scope and initial audit

Implementation was requested explicitly by the user. `AGENTS.md` is not an edit
or bootstrap target. The sibling game repository is read-only. Existing working
changes (including removed reference library objects and earlier scaffolding
work) are not implementation changes and will not be reverted.

Protected instruction baseline: `../btn-decompilation` commit
`fdedbe9f68cce6de7a5811e7b05ff32fd74bf601`.

A read-only, per-file SHA-256/byte audit before implementation found:

- Different: `AGENTS.md` (pre-existing; must remain unchanged),
  `prompts/reference/flags.md`, `.pi/skills/psx-decompile-function/SKILL.md`,
  `.pi/extensions/psx-decomp/tools/diagnostics.ts`.
- All other required active baseline paths are present and byte-identical.
- `prompts/legacy/` is absent and excluded deliberately.

Audit artifacts: `build/installed-runtime/audit/protected.json`,
`preexisting.diff`, `agents-preexisting.diff`, and `initial-status.txt`.
These generated artifacts are not distribution inputs or commits.

## Performance baseline setup

Current game HEAD recorded before orchestration changes:
`5bf2f1d2791cad57cfd03067d44f67db1339165e` (distinct from the protected
instruction baseline). A disposable, no-hardlinks clone was created; extracted
inputs are linked read-only by workflow (no extraction/conversion writes through
that link). Public/compiler support sources were copied into the disposable
baseline. An unrelated historical homebrew compiler file was unreadable; it is
not used by the configured GCC 2.95.2 compile protocol. Baseline dependency
modules are shared read-only. Host Pi is 0.85.1; Node is v24.1.0.
Workspace/tool/input hashes and environment are recorded under
`build/installed-runtime/baseline-environment.json`.

## Progress

- [x] Read-only protected-path audit before implementation.
- [x] Record game HEAD and create disposable baseline clone.
- [x] Record all nine three-run baseline scenarios before orchestration edits.
- [x] A: correctness fixes and focused tests.
- [x] B: explicit contexts, production graph, cache/history and provided tools.
- [x] C: external bootstrap, inputs, worktrees and project parser plugins.
- [x] D: one `.mk` override reader and scoped authorization parity.
- [x] I: minimal recorded instruction substitutions and byte-preservation gates.
- [x] E: verification sequencing, performance repairs, negative controls and timings; timing-table-only commit `4aeedb8`.
- [x] Installed production consumers, portable suite and distribution verification.

## Persisted-artifact inventory (before key changes)

- Durable, append-only: `build/experimentLedger/*.jsonl`, its `sources/` and
  `closed/` trees; measured preparation sources, packets, evidence and command
  transcripts in `build/preparation/`; loop threshold observations in
  `build/loopTrace/threshold.json`. Cleanup must preserve these records.
- Stable comparisons: relocated instruction/object fingerprints, target/context
  hashes, effective compiler/assembler flags and residual schema; producer paths,
  package releases and commits are provenance, not equality inputs. Existing
  rows remain readable; missing semantic witnesses are reported as a limit.
- Disposable derivatives: preprocessor bundles, compiler objects/pass dumps,
  reconstruction/search caches, asset decode caches, source indexes and prepared
  dependency trees. Their compatibility keys belong to each producing component,
  with only relevant target/tool/flag/header inputs. Package-wide identities must
  not invalidate unrelated function packets or erase historical measurements.

## Exact instruction patch ledger

Machine-readable exact spans are recorded in
`plans/installed-package-runtime-instruction-edits.json`; the completed record
below will render each old/new span verbatim. I2 restorations are separate from
I1 tooling substitutions. The original divergence remains in the read-only
audit, rather than becoming a new baseline.

### I2 restorations applied

- `prompts/reference/flags.md:32–40`: restored fdedbe9f bytes verbatim.
- `.pi/skills/psx-decompile-function/SKILL.md:146`: restored fdedbe9f line.
- `.pi/skills/psx-decompile-function/SKILL.md:253–258`: restored fdedbe9f
  paragraph, then changed only `exact\n   patched compiler tree cc1 is built
  from` to `configured\n   compiler source` for the configured source resolver.

## Focused checks in progress

The initial correctness/context tests pass (44 tests): additive bootstrap,
trackable lib objects/archives, dependency-cache provisioning without copied
implementation, original-input/config/npm/instruction preservation, grouping
annotation parity, strict `.mk` grammar, concurrent context isolation, explicit
path origins and declared worktree input mounts. Full installed-runtime and
production-graph checks are not yet complete.

`build/installed-runtime/preexisting-typecheck.log` records the pre-existing
TypeScript failures before graph conversion; these are not hidden by excluding
files or weakening typecheck.

The timing driver now resets only disposable tracked `src/`, `include/` and
`configs/` state between cold repetitions and preserves durable ledger history.
Pilot measurements (including setup failures from copied submodule metadata)
are retained separately under `build/installed-runtime/pilot-timings/` and are
not acceptance timings. All 27 authoritative baseline rows completed at 2026-10-10T19:45:25Z,
before production graph/orchestration conversion started.

Additional isolated checks pass: SDK first-time conversion (both collisions and
unique members) into trackable `lib/`, hash/provenance preservation, idempotence
and refusal to overwrite different objects; project parser preparation, fixed-argv
policy/typecheck/test admission, installed built-in immutability, discovery,
content-addressed runtime loading after same-process edits and read-only replay.
No parser implementation or registry is copied into the installed package.
Pi tool measurements use Pi 0.85.1 resource loading/registration provenance and
complete no-model tool dispatch, not diagnostic microbenchmarks.

## Verbatim instruction edits

### I2 restoration: prompts/reference/flags.md:32

I2: authoritative fdedbe9f lines 32–40; restore the agent-owned .mk/evidence/allowlist idiom verbatim. Initial divergence is preserved in build/installed-runtime/audit/preexisting.diff.

Exact old text:

```text
the bar is met, propose a human-reviewed change to `toolchain.json.fileFlags`,
record its evidence in project metadata, and add the matching `flag-override`
allowlist entry in `.pi/autoloop.json` in the same change. The allowlist is the
audit trail the policy gate enforces; workers may not edit the toolchain or
grant themselves an exception. Do not add an override without a fingerprint,
and never switch off an optimization the target shows signs of using. A probe
that shows baseline equal to the flag delta kills that flag hypothesis; measure
a different source shape rather than treating historical examples as target
evidence.
```

Exact new text:

```text
the bar is met, apply the override yourself: add the `CC1FLAGS_<stem>` entry
in `configs/flag_overrides.mk` with a comment stating the evidence, and add
the matching `flag-override` allowlist entry in the project configuration in
the same change — the allowlist entry is the audit trail the policy gate
enforces. Do not stop at "proposing" an override the evidence already
supports; do not add one without a fingerprint. A probe that shows baseline
equal to the flag delta means the flag is NOT the answer and the source shape
is (func_8001FF98: the probe's matrix exposed exactly this, killing a wrong
override within minutes).
```

Required fdedbe9f baseline span:

```text
the bar is met, apply the override yourself: add the `CC1FLAGS_<stem>` entry
in `configs/flag_overrides.mk` with a comment stating the evidence, and add
the matching `flag-override` allowlist entry in the project configuration in
the same change — the allowlist entry is the audit trail the policy gate
enforces. Do not stop at "proposing" an override the evidence already
supports; do not add one without a fingerprint. A probe that shows baseline
equal to the flag delta means the flag is NOT the answer and the source shape
is (func_8001FF98: the probe's matrix exposed exactly this, killing a wrong
override within minutes).
```

### I2 restoration: .pi/skills/psx-decompile-function/SKILL.md:146

I2: remove the non-tooling OBSERVE/re-reading addition; restore authoritative line 146.

Exact old text:

```text
Use only the reference sheet for the owning pass; do not reread one already
loaded in OBSERVE:
```

Exact new text:

```text
Consult the reference sheet for the owning pass only now, and only the one:
```

Required fdedbe9f baseline span:

```text
Consult the reference sheet for the owning pass only now, and only the one:
```

### I2 restoration: .pi/skills/psx-decompile-function/SKILL.md:253

I2: restore authoritative lines 253–258; remove added compiler-evidence sentences, preserving all surrounding bytes.

Exact old text:

```text
   for the pass is the short form. `psx_compiler_source` searches the configured
   compiler source; for a supported, verified compiler build it is the authority
   where no sheet covers the decision. One read of the function that makes the
   choice can name the source change outright, or end a search: a proof that a
   form is unreachable is worth more than any number of failed experiments, and
   it is the only evidence that converts "we could not find it" into "it is not
   there". A default compiler profile alone does not establish that premise.
```

Exact new text:

```text
   for the pass is the short form. `psx_compiler_source` searches the exact
   patched compiler tree cc1 is built from, and is the authority where no sheet
   covers the decision. One read of the function that makes the choice can name
   the source change outright, or end a search: a proof that a form is
   unreachable is worth more than any number of failed experiments, and it is the
   only evidence that converts "we could not find it" into "it is not there".
```

Required fdedbe9f baseline span:

```text
   for the pass is the short form. `psx_compiler_source` searches the exact
   patched compiler tree cc1 is built from, and is the authority where no sheet
   covers the decision. One read of the function that makes the choice can name
   the source change outright, or end a search: a proof that a form is
   unreachable is worth more than any number of failed experiments, and it is the
   only evidence that converts "we could not find it" into "it is not there".
```

### I1 tooling substitution: .pi/skills/psx-decompile-function/SKILL.md:253

B1: compiler.source names configured, explicitly owned source rather than an unconditional fixed patched tree.

Exact old text:

```text
exact
   patched compiler tree cc1 is built from
```

Exact new text:

```text
configured
   compiler source
```

### I1 tooling substitution: .pi/skills/psx-prepare-function/SKILL.md:38

B3: registered narrow classification tool invokes installed implementation with explicit project context.

Exact old text:

```text
npx tsx tools/build/classifyGlobals.ts --write
```

Exact new text:

```text
psx_classify_globals({write: true})
```

### I1 tooling substitution: prompts/reference/declarations.md:50

B3: narrow independently witnessed TU-global report tool.

Exact old text:

```text
tools/build/deriveTuOwnedGlobals.ts <function>
```

Exact new text:

```text
psx_derive_tu_globals({functionName: "<function>"})
```

### I1 tooling substitution: prompts/reference/stuck.md:24

A4/B3: installed shared split operation, no Makefile dependency.

Exact old text:

```text
make split
```

Exact new text:

```text
psx_split_project
```

### I1 tooling substitution: prompts/reference/population.md:494

E1: executable-only byte verification, same 120 s scope.

Exact old text:

```text
make check
```

Exact new text:

```text
psx_verify_build
```

### I1 tooling substitution: .pi/skills/psx-decompile-function/SKILL.md:380

B3/I3: skill-relative installed package resource, not a project-relative tools path.

Exact old text:

```text
tools/agent/pipeline-reversal/README.md
```

Exact new text:

```text
../../../tools/agent/pipeline-reversal/README.md
```

### I1 tooling substitution: .pi/skills/psx-build-resource-parser/SKILL.md:18

C4: project-authored parser implementations live outside installed package.

Exact old text:

```text
tools/agent/resource-extraction/parsers/<format>.ts
```

Exact new text:

```text
tools/resource-parsers/<format>.ts
```

### I1 tooling substitution: .pi/skills/psx-build-resource-parser/SKILL.md:20

C4: project registry is prepared/preserved independently of built-ins.

Exact old text:

```text
tools/agent/resource-extraction/parser-plugins.ts
```

Exact new text:

```text
tools/resource-parsers/parser-plugins.ts
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/diagnostics.ts:211

B1/I2: only the stale fixed-tree clause is replaced in the authoritative description.

Exact old text:

```text
tools/vendor/gcc/<GCC_VERSION>, the exact patched tree cc1 is built from
```

Exact new text:

```text
the configured compiler source
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/diagnostics.ts:217

B1/I2: configured compiler version replaces removed Make variable; every surrounding description byte stays authoritative.

Exact old text:

```text
defaults to the Makefile's GCC_VERSION
```

Exact new text:

```text
defaults to toolchain.json compiler.version
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/diagnostics.ts:584

B3/E1/I2: provided terminal/finalize and executable verification operations replace the obsolete Make invocation.

Exact old text:

```text
psx_finalize_function / make check afterward
```

Exact new text:

```text
psx_finalize_function / psx_verify_build afterward
```

### I1 tooling substitution: .pi/extensions/psx-decomp/autoloop/prompts.ts:180

B3: project preparation performs internal rodata derivation/repair and splitting through the shared configured API.

Exact old text:

```text
npx tsx tools/build/deriveRodataSplits.ts " +
        "--container <id>
```

Exact new text:

```text
psx_split_project(" +
        "{container: \"<id>\", repairRodata: true})
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:3

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
complete project source scaffold
```

Exact new text:

```text
complete project scaffold
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:19

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
entire source scaffold
```

Exact new text:

```text
entire project scaffold
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:20

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
configs, build/diagnostic tools, reference sheets, local matching and
   resource extensions/skills, and pinned public vendor tooling sources (copied
   when present, downloaded automatically when missing)
```

Exact new text:

```text
configs, project loop settings, plugin directories, and pinned public
   tooling sources in build/dependencies/ (prepared from the installed package
   when present, downloaded automatically when missing)
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:25

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
merges `.gitignore` and npm scripts/dependencies
```

Exact new text:

```text
merges `.gitignore`
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:39

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
matching release headers under `include/psyq/`
```

Exact new text:

```text
matching release headers under `library-input/psyq/INCLUDE/`
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:43

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
EXE SDK
     integration still requires first-time conversion of non-colliding members
```

Exact new text:

```text
EXE SDK
     integration performs supported first-time conversion of non-colliding members
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:45

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
project `npm install`
```

Exact new text:

```text
installed package dependencies
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:49

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
Install project dependencies with `npm install --ignore-scripts` from the
   target repository, then run `npm run setup` to verify/prepare m2c.
```

Exact new text:

```text
Prepare supported tooling with `psx_prepare_tooling` from the
   target repository to verify/prepare m2c.
```

### I1 tooling substitution: .pi/skills/psx-bootstrap-project/SKILL.md:56

C1/B3: remove copied implementation/dependency mutation boundaries; psx_prepare_tooling verified through Pi 0.85.1, installed resource links remain skill-relative.

Exact old text (preimplementation, absent from fdedbe9f):

```text
`docs/bootstrap.md` rather than
```

Exact new text:

```text
[the onboarding contract](../../../docs/bootstrap.md) rather than
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/call-graph.ts:10

B3: the registered operation executes installed code, not a missing consumer path.

Exact old text:

```text
with tools/agent/callGraph.ts
```

Exact new text:

```text
with the installed implementation
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/diagnostics.ts:350

B3: the existing registered integration tool replaces the raw CLI follow-up.

Exact old text:

```text
finalizeEngineMatches --write
```

Exact new text:

```text
psx_finalize_engine_matches({write: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:15

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
`.pi/skills/psx-identify-project/`
```

Exact new text:

```text
`./`
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:23

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
Bootstrap materializes this skill and its tools locally
```

Exact new text:

```text
The installed package supplies this skill and its tools
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:38

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
`npm ci` installs TypeScript tooling;
   `npm run setup` prepares vendors
```

Exact new text:

```text
The installed package supplies TypeScript tooling;
   `psx_prepare_tooling` prepares vendors
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:92

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run identify -- --deep --json
```

Exact new text:

```text
psx_identify_project({deep: true, json: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:55

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run identify -- --json
```

Exact new text:

```text
psx_identify_project({json: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:90

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run identify -- --json
```

Exact new text:

```text
psx_identify_project({json: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:65

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/diagnostics/headerInfo.ts extracted/YOUR-EXE build/identification/header.md
```

Exact new text:

```text
psx_inspect_exe({input: "extracted/YOUR-EXE", output: "build/identification/header.md"})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:135

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run disassemble -- --archives
```

Exact new text:

```text
psx_disassemble_project({archives: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:91

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run disassemble
```

Exact new text:

```text
psx_disassemble_project({})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:102

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
`tools/diagnostics/matchSignatures.ts`
```

Exact new text:

```text
`psx_match_sdk_signatures`
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:108

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/diagnostics/matchSignatures.ts --version VERSION
```

Exact new text:

```text
psx_match_sdk_signatures({version: "VERSION"})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:107

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/diagnostics/matchSignatures.ts
```

Exact new text:

```text
psx_match_sdk_signatures({})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:119

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run split-sdk-libs
```

Exact new text:

```text
psx_prepare_sdk
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:120

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/build/detectLibFunctions.ts
```

Exact new text:

```text
psx_prepare_sdk({verifyPlacements: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:124

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
headers under `include/psyq/`
```

Exact new text:

```text
headers under `library-input/psyq/INCLUDE/`
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:125

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
First-time non-colliding conversion is
not performed
```

Exact new text:

```text
First-time non-colliding conversion is
performed for supported inputs
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:136

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/diagnostics/overlayFlagFingerprint.ts
```

Exact new text:

```text
psx_inspect_container_abi({})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:141

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
`tools/build/extractArchive.ts` for explicit `--index`/`--data` selection
```

Exact new text:

```text
`psx_extract_archive` for explicit `index`/`data` selection
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:169

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
- `fileFlags`: leave empty without per-TU target fingerprints, dominant probe
  evidence, no contrary regional witness and a human-approved policy allowlist.
  Ordinary workers must not modify toolchain authority.
```

Exact new text:

```text
- `configs/flag_overrides.mk`: leave empty without per-TU target fingerprints, dominant probe
  evidence, no contrary regional witness and a matching policy allowlist.
  Ordinary workers must not modify toolchain authority.
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:185

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run split-all
```

Exact new text:

```text
psx_split_project({all: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:186

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run check-all
```

Exact new text:

```text
psx_verify_project({})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:187

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npx tsx tools/build/genProjectProfile.ts --write
```

Exact new text:

```text
psx_generate_project_profile({write: true})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:188

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run progress
```

Exact new text:

```text
psx_project_progress({})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:191

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run split -- --container ID
```

Exact new text:

```text
psx_split_project({container: "ID"})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:192

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run check -- --container ID
```

Exact new text:

```text
psx_verify_project({container: "ID"})
```

### I1 tooling substitution: .pi/skills/psx-identify-project/SKILL.md:193

B3/C1/D1: registered narrow installed operations replace missing consumer scripts/tasks; SDK header ownership and .mk mutation boundary moved. Surrounding bytes retained.

Exact old text (preimplementation, absent from fdedbe9f):

```text
npm run config-check
```

Exact new text:

```text
psx_check_configuration
```

### I1 tooling substitution: .pi/extensions/psx-decomp/tools/verify-build.ts:10

E1: restore the provided executable-only 120 s verification scope; finalize retains all-container 300 s verification.

Exact old text:

```text
full byte-identity verification with make check
```

Exact new text:

```text
executable-only byte-identity verification (120 s timeout)
```

### I1 tooling substitution: .pi/extensions/psx-bootstrap/index.ts:14

C1/A2: bootstrap no longer merges dependencies/npm tasks or copies package implementation.

Exact old text (preimplementation, absent from fdedbe9f):

```text
merges npm scripts/dependencies and .gitignore, refuses implementation collisions.
```

Exact new text:

```text
merges .gitignore without copying implementation.
```


## Additional exact I1 runtime follow-up edits

### I1 tooling substitution: .pi/extensions/psx-decomp/autoloop/park.ts:221

B3: registered split operation owns the internal rodata derivation; parked-function follow-ups cannot invoke missing consumer scripts.

Exact old text:

```text
npx tsx tools/build/deriveRodataSplits.ts --container <id>
```

Exact new text:

```text
psx_split_project({container: \"<id>\", repairRodata: true})
```

### I1 tooling substitution: .pi/extensions/psx-resources/controller.ts:79

B3/C4: the installed resource tool loads project-authored plugins; a fresh consumer has no copied extraction npm task.

Exact old text:

```text
npm run extract-assets
```

Exact new text:

```text
psx_resource_extract({})
```

### I1 tooling substitution: .pi/extensions/psx-decomp/autoloop/oracles.ts:155

E1/B3: report the internal all-container build gate, not a nonexistent consumer npm invocation; scope and surrounding output retained.

Exact old text:

```text
npm run check-all
```

Exact new text:

```text
all-container verification
```

## Sequential acceptance checkpoints

- Portable suite: 1,338 tests, 1,222 passing, zero failures, 116 configured-real-asset skips (`portable-fifth.log`). Later changes await the final rerun.
- Verification scope/sequence: 10 passing checks for executable-only 120 s versus all-container 300 s, successful-only profile refresh, and one final all-container rodata verification (`verification-scope-tests.log`).
- Production-only installation: real Pi 0.85.1 `pi install --local`, EXE/library bootstrap/setup, packaged skill/description references, and project-parser test/accept/extraction; three tests passing, package bytes unchanged (`installed-consumer-tests.log`).
- Installed update: a real synthetic compile/preparation/measurement before and after reinstallation at another path with unrelated code/version changes. Packet and ledger bytes unchanged; equal output recognized. Target/header/compiler/applicable-override changes invalidate, unrelated overrides do not, and a preparation contract change leaves compilation identity unaffected (`installed-upgrade-tests.log`).
- Real Git worker: HEAD has no copied implementation; installed split and provided preparation run in worker context, raw inputs are declared mounts, lib/derived extraction are private. Existing tree/patch integration carries source plus `.mk` evidence and allowlist. Missing authorization fails; unrelated pre-existing overrides do not block. Parent inputs/package remain unchanged (`installed-worktree-tests.log`).
- Actual compiler argv: EXE and overlay builds, sync/async diagnostics, loop/probe, triage, residual and preparation agree on container base followed by applicable override. Malformed `.mk` assignments fail with file/line errors across routes (`compile-route-parity-tests.log`). The probe now retains existing applicable overrides, and triage does not swallow invalid override grammar.
- These installed checks exposed and fixed concrete issues: the generated parser registry export; pure parser tests incorrectly depending on checkout configuration; absent empty SDK BSS output; scaffold platform headers hardcoding the legacy SDK location; macro census using that legacy location; a probe reading an overlay as EXE; and inherited open stdin blocking file-mode maspsx in noninteractive builds.

These are historical checkpoints, superseded by the final acceptance record below.

## Final acceptance record

All implementation and measured acceptance gates pass. The timing table is
`plans/installed-package-runtime-timings.md`, committed alone as `4aeedb8`
(`Record installed-package runtime acceptance timings`). No other path is in that
commit; unrelated staged entries were verified unchanged. Source changes and
pre-existing WIP remain uncommitted.

### A — independent correctness repairs

Trackable lib objects/archives and ignored raw inputs/build outputs are verified
by scaffold/ignore preservation checks. Bootstrap preserves existing inputs,
configuration, headers, overrides, npm tasks and Pi settings, and emits no
regular Pi development pin. Annotated grouping entries use the shared reader.
Requested linked-byte verification uses the configured build API, refuses
failed/missing/truncated/differing outputs and propagates a failing exit verdict
(`linked-byte-tests.log`). Neither the production path nor a compensating shim
requires Make.

### B/C — installed ownership, consumers, history and workers

Package/project/runtime ownership is explicit; configuration discovery starts
from the requested path or Pi cwd. The final ownership inventory is
`context-inventory-final.txt`: remaining URL-derived roots belong to bundled
support/code fingerprints or standalone-entrypoint identity, never target data.
The remaining module dirname declarations are unused legacy declarations, not
target resolvers. No production process.chdir boundary remains. Same-process
project switches/config edits and invocation-scoped metadata are exercised by
the context/compiler fixtures.

The production-only npm installation uses hoisted runtime dependencies and the
real Pi 0.85.1 resource/registration interfaces. Fresh EXE/library bootstrap,
installed instructions/skills, preparation/diagnostics, package relocation with
unrelated changes, real Git worker operation, configuration convergence and
its deliberate-drift failure, and project parser prepare/test/accept/extraction
pass (`installed-final-tests.log`). Installed package and shared raw inputs
remain unchanged during those operations. Worker source plus .mk evidence and
allowlist changes use the existing tree/patch integration. Lib and writable
derived extraction are private; only declared raw input leaves are shared.

Measured preparation/ledger/source records survive reinstall unchanged; equal
output remains equal under compatible target/context/compiler/residual domains.
Legacy rows remain visible, with missing compatibility witnesses explicitly
reported rather than equated or retired. Applicable target/header/compiler/flag
changes invalidate dependent evidence; unrelated tool/location/override changes
do not invalidate compatible packets. A preparation-contract change leaves
independent compilation identity intact. The configured cpp frontend is shared
by preparation, preprocessing and build identity; changing frontend bytes without
changing its driver invalidates the affected identities
(`cpp-frontend-tests.log`, `installed-final-tests.log`).

Public tooling and patched m2c write into project dependency caches. The pinned
m2c snapshot includes the upstream .gitignore bytes omitted by npm packaging;
this is an exact public-source supplement, not a weakened pin. Automatic missing
supported compiler provisioning, argv/cwd, output/provenance publication and
failure preservation are verified using an explicitly synthetic Docker fixture
(`compiler-provision-tests.log`). A real Docker compiler-image build was not
performed in this session; the existing supported recipe is unchanged. No SDK
inputs are fetched. SDK first extraction uses configured originals, converts
both unique and colliding members into trackable project lib, retains provenance,
and refuses differing pre-existing outputs. Synthetic converter fixtures do not
claim original PSY-Q LNK encoding identity.

### D/I — override and instruction parity

Build, synchronous/asynchronous diagnostics, loop/probe, triage, residual and
preparation compiler argv agree on container-effective base plus applicable
.mk override; malformed non-comment assignments fail with file/line evidence
(`compile-route-parity-tests.log`). Existing source restrictions, scoped override
allowlists and worker integration remain intact. Missing authorization fails;
unrelated old unallowlisted entries do not block another function. The JSON
fileFlags channel is refused, not merged.

Active protected instruction/description bytes match the recorded authoritative
baseline plus the exact I1/I2 ledger. Flags and the specified non-tooling skill
divergence are restored verbatim. Real installed references resolve; stale
reference/parameter negative fixtures fail. Runtime literal usage/error/next-step
inventory passes, including typed parameter values; final/update/error output is
formatted through registered tools. JSON reports keep their structure and actual
command/argv evidence. Human CLI maintenance remains intentionally unexposed;
there is no agent runner, old-spelling alias or production interception
(`hint-inventory-tests.log`, `installed-final-tests.log`). The entire resource
controller also independently matches baseline bytes plus its recorded I1 span.
Historical research notes have not been rewritten.

AGENTS.md's SHA-256 remains
`3b05b0f7064f14be8ba516a1a3518e1979c93f0f02982803817a95c65df7d12d`,
the initial pre-existing WIP fingerprint. It was never edited/copied/restored.
Prompts/legacy remains absent. The sibling game was never modified by this task.

### E — verification and measured performance

Complete original-byte comparisons and verdicts pass in the isolated game clone.
The material overlay-profile and per-TU-override removal controls fail original
byte verification after forced rebuilds; restored positive controls pass.
Executable-only verification retains 120 seconds; all-container finalization
retains 300 seconds. Successful-only EXE profile refresh, failure ordering,
skipped per-container verification rodata and one final all-container derivation
are verified (`verification-scope-tests.log`, final timing/control transcripts).

All required scenarios satisfy the rule recorded before the corrected series:
every harness wall time is no greater than its baseline median plus measured
baseline range. The table shows every repetition, noise and ceiling; exact argv,
environment, revisions, package/input hashes and complete results are retained.
The interrupted final series resumed only unfinished operations; completed rows
and earlier slow measurements were not erased/replaced. CPU evidence identified
unused eager preparation/context-export module loading; imports now occur only
when those operations need them. No tool, byte comparison, policy gate or timeout
was removed to gain performance.

### Final verification and limitations

`portable-final.log` and `installed-final-tests.log` pass. Configured-original-asset
portable guards remain explicit; required actual game-byte evidence comes from
the disposable clone, not an unavailable harness-local game input. The distribution
scan finds no supplied SDK/library/original binaries, local compiler builds,
extracted inputs, runtime caches or legacy prompts. Public compiler license files
such as COPYING.LIB are support-source notices, not proprietary SDK archives.

Typecheck still reports pre-existing failures. The initial default-root diagnostic
log did not reach all hidden extension modules; an isolated HEAD snapshot with
full production-extension reach establishes those additional existing errors.
`typecheck-final-comparison.json` records no new diagnostics and preserves both
raw reports. No tsconfig flags were weakened and no files were excluded to hide
failures. This is not a claim that the inherited whole-project typecheck is clean.

Only the timing table is committed (`4aeedb8`). No source migration,
proprietary/generated binary artifact, extracted input or unrelated/pre-existing
change is committed. Final closure completed at 2026-10-10 16:40 PDT, within the
requested remaining-work deadline.

## Subsequent authorized commits

After the closure above, the user explicitly requested committing all changes in
logical groups. The earlier statement about uncommitted source describes the
state at closure, not the final repository state.

- `4aeedb8`: measured installed-package acceptance timings.
- `60e5998`: removal of the pre-existing bundled SDK library artifacts.
- `254f31a`: installed runtime, project ownership, bootstrap, Pi integration,
  supporting fixtures, instruction ledger and current usage documentation.
- This documentation commit records the original plan and its completed
  implementation together.

The commit-all authorization also covers the preserved pre-existing working-tree
changes. No proprietary/generated binary artifact or extracted input was added;
AGENTS.md retains its original working-tree bytes, and the sibling game remains
untouched.
