# Prompt resources

Active Pi workflows live under `.pi/skills/`; repository-wide rules live in
`AGENTS.md`.

`reference/` holds per-pass mechanism sheets served by `psx_reference`. The
pipeline reversal names the sheet for the pass that owns a residual, and triage
findings link the sheet for their symptom. Read the relevant sheet, not all of
them.

The standalone C style guide is retired. Its natural-C rule lives in
`.pi/skills/psx-decompile-function/SKILL.md`; the remaining rules live in
`AGENTS.md`, the sheets or the tools. Configured choices come from
`toolchain.json`; target facts and their evidence belong in the generated
`configs/project-profile.md`, not repeated in prompts.

## Archived templates

`legacy/` contains templates from the retired standalone prompt-injection
workflow, retained for manual prompt reproduction with
`tools/agent/getPrompt.ts`. Pi commands and autonomous workers do not load them.

These are historical artifacts, not supported harness instructions. Their bodies
still assume fixed source/header paths, Make commands and outdated matching or
policy advice. Injecting the current repository guide does not generalize that
workflow. Use the active skills for new work; remaining assumptions are called
out in [the generalization checklist](../docs/game-agnosticity.md).
