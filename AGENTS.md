# Repository Agent Guide

This is the top-level guide for any agent working in this repository. It
contains repository-wide policy and routes task-specific work to the relevant
instructions. It is not a function-decompilation prompt. Follow more specific
task instructions after this guide; when they conflict with repository-wide
policy, stop and ask rather than silently weakening the policy.

## Sources of truth

- `toolchain.json` is the source for configured tools/flags/SDK/profiles. Configuration is not evidence about the original compiler.
- `configs/project-profile.md`, when generated, is the prompt-facing target profile; read its evidence and verification status rather than treating defaults as measured facts.
- `README.md` documents project architecture, setup, build flow, and the tools
  inventory. Read it for project-level, build-system, or tooling work.
- The active project configuration and generated artifacts are authoritative
  for paths, symbols, sections, and build behavior.

## Route by task

- Scaffolding a repo after `pi install --local`: load
  `.pi/skills/psx-bootstrap-project/SKILL.md` from the installed package. Default
  to `exe`; use `library` only when requested. See `docs/bootstrap.md`. The
  consumer project is the current working directory, not the package checkout.
- Identifying unfamiliar assets or configuring a new project: load `.pi/skills/psx-identify-project/SKILL.md`.
- Preparing m2c output to compile (autoloop `prep` role): load
  `.pi/skills/psx-prepare-function/SKILL.md`. This is preparation, not matching;
  hand the compiling candidate and context to the next tier.
- Matching or repairing one function: load
  `.pi/skills/psx-decompile-function/SKILL.md`. Check `notes/file-groupings.md`
  for the target's suspected source-file group if that project ledger exists,
  and update it when you find grouping evidence. This template supplies no game research.
  - Never read a large grouping ledger whole. Search with `grep -n` for the
    full function name and its address without the name prefix, then read only
    the section around each hit. Sections use `## ` headings naming the
    container and address range. Extend the section already listing the
    function instead of creating a duplicate.
  - `psx_reference` serves the mechanism sheets: `population`, `loop`,
    `schedule`, `allocation`, `declarations`, `flags`, `sdk` and `stuck`.
    Read only the sheet for the pass that owns the residual.
  - Where no sheet covers a decision, use `psx_compiler_source` to read the
    configured compiler source. Treat it as authoritative only for a supported,
    verified compiler build, not merely because a default profile names it.
- Refining an already-matching function: load
  `.pi/skills/psx-refine-function/SKILL.md`.
- Performing a conservative cross-file cleanup batch: load
  `.pi/skills/psx-project-refinement/SKILL.md`.
- Changing Pi extensions, skills, commands, or autonomous workers: read the Pi
  documentation named in the harness instructions and inspect the relevant
  `.pi/` implementation and tests. Point guides, skills and prompts at the
  generated project profile for target facts and `toolchain.json` for configured
  choices; do not restate defaults as measured evidence.
- Changing build or diagnostic tooling: read `README.md` and
  `docs/toolchain.md` and the relevant npm task/configuration dependencies before editing.
- Changing project fundamentals: inspect the current project's evidence and `docs/game-agnosticity.md`. There is no inherited roadmap or game research ledger to consult.

## Declarations

Resolve header roles from `configs/project-profile.md`; the paths below are
this template's defaults, not universal game facts.

- A data symbol's `extern`, type and struct view belong in the project's
  global-override header (default `include/globals_override.h`). Search that
  header for the symbol before declaring it or looking elsewhere; it need not
  be in address order.
- In the default scaffold, `common.h` reaches the override header through
  `globals.h`. Generated declarations skip overridden symbols and may cover
  only part of the rest. A missing declaration belongs in the override header,
  not a `.c` file or a hand-edited generated header.
- Put shared parameter/local struct types in the shared-type header (default
  `include/game_types.h`), and include it explicitly where its types are used.
- Add a missing global with a one-line evidence comment. The profile's header
  table identifies generated outputs that must never be hand-edited.
- A source file must still *define* (tentatively) every global whose translation
  unit it is: that is how GP-relative addressing is expressed. A definition is
  not a redeclaration; see `psx_reference declarations`.

## Repository-wide rules

- **No internet research.** Do not search the internet, browse external sites,
  or fetch online reference material or source code. This applies to every
  agent and worker, including when matching stalls. Do not use web-search or
  browser skills, `web_fetch`, Brave Search, GitHub/grep.app APIs, or shell
  commands such as `curl`/`wget` as a workaround. Use local project artifacts,
  vendored sources, SDK headers, matched code and compiler/byte evidence only.
  If required evidence is missing locally, report that gap; it is not permission
  to search online.
- Never commit unless the user explicitly asks. Never commit generated or
  extracted binary artifacts.
- Tooling is TypeScript and runs through `npx tsx`. Do not check in Python
  scripts.
- Put tools, configuration, and headers in the repository's established
  directories rather than creating parallel structures.
- C source follows C89: declarations at the top of a block, `/* */` comments,
  and no C99 features.
- Do not hand-edit generated files. Change their source configuration or
  generator and regenerate them.
- Preserve the clean-source policy. For ordinary compiled functions, embedded
  assembly, hard-register pinning, and new assembly stubs are not valid
  decompilation solutions. Honor only exceptions established by the active
  project's classification and policy. Evidence-backed shared operation macros
  are an authorized route: create them in project include files when positive
  SDK/original-code evidence and unchanged-production byte checks establish the
  operation. Follow `docs/macro-evidence.md` and record exceptional definitions
  in `configs/macro-evidence.json`. No per-macro human approval or allowlist
  change is required. Being stuck or forcing an ordinary allocation is not evidence.
- A per-file compiler flag override needs the evidence bar in
  `psx_reference flags`, and lands with its evidence comment and allowlist
  entry in the same human-reviewed change (`configs/flag_overrides.mk`; keep
  evidence in project metadata). Workers may not change the toolchain. Without
  that evidence an override is forbidden. Never use a flag to switch off an
  optimization the target shows signs of using.
- Keep edits scoped to the requested task. Do not opportunistically rewrite
  unrelated files.

## Verification discipline

Keep scaffolding checks lean. With configured target inputs, run `npm run check-all` before claiming game-byte identity; a function match alone is insufficient. Without those assets, report the limitation rather than inventing a verified result. A generated binary match does
not excuse forbidden source constructs, out-of-scope edits, or hand-edited
generated files.

While iterating on one function, the narrowest check is the staged residual,
not a byte score. A byte score is not a distance — an edit that fixes the cause
of a difference rotates everything downstream of it and can match fewer words
while standing closer — so it ranks a lucky register assignment above a fixed
cause. Measure every edit, and measure it with the residual.

When a residual survives several spellings, stop writing spellings. Read the
compiler function that makes the decision, through its mechanism sheet or the
configured source. The rule it applies can name the source change; another
spelling only samples it.

When a verification step fails, continue from its concrete output or restore
the last known-good state. Do not leave unrelated source broken to preserve an
experiment.

## Repository layout

- `src/` — function source files
- `include/` — common, generated, shared-type, override, and SDK headers
- `configs/` — project configuration and generated profile
- `.pi/` — active Pi commands, skills, tools, and autonomous workflow
- `tools/` — build, diagnostic, matching, and shared TypeScript tooling
- `prompts/` — per-pass mechanism sheets and archived standalone templates
- `notes/` — tooling inventory only; project research is not supplied
- `build/` — generated build and diagnostic artifacts
- `extracted/` — local extracted inputs

