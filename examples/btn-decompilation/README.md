# Historical BTN project inputs

This is a snapshot of project-specific support files from
`../btn-decompilation` at migration time, not a runnable game project:

- `configs/`: splat/symbol/overlay metadata, flags, SDK evidence, benchmark cohorts, profiles.
- `include/`: original common/generated/game-type/global-override and platform headers.
- `Makefile`: original build entry point.
- `.pi/autoloop.json`: original loop configuration, including game-specific policy exceptions.

The snapshot includes the source working tree's then-current edits to
`configs/flag_overrides.mk` and `include/globals_override.h`. Its base revision is
recorded in `../../docs/migration.md`. No recovered source or extracted game
binaries are included, and none of these files is active root configuration.

**Do not use these addresses, types, measured flags, verification claims, or
policy approvals for another game.** Keep the examples for migration comparison
and explicit project adapters. Generalization obligations are tracked in
`../../docs/game-agnosticity.md`.
