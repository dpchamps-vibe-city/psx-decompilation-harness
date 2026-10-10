# Inherited regression fixtures

These fixtures were duplicated to retain regression coverage and provenance.
Some deliberately use BTN functions or addresses. Self-contained example inputs
are legitimate fixtures, not runtime game metadata or symbol-keyed special cases.

Some inherited tests elsewhere still depend on the original game binary, source,
generated build files, or repository history. Separating those opt-in integration
tests from portable synthetic contracts remains a migration task; see
`../docs/game-agnosticity.md` and `../docs/migration.md`.
