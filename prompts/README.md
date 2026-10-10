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
