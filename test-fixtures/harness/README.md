# Portable harness fixtures

Existing regression tests use these small declarations/control shapes and the
helpers in `tools/testing/` instead of another game's assets or build outputs.
Borrowed shapes retain the behavior being tested, not game context or approvals.

- `projectFixture.ts` creates an isolated PS-X EXE/overlay project: original
  instruction words, symbols, section boundaries, manifests and toolchain config.
  Addresses/GP are synthetic test geometry, never bootstrap defaults. Gaps
  between functions are data, not instructions attributed to the preceding body.
- `harnessFixture.ts` runs ROOT-bound modules in a temporary harness tree. It
  shares installed tools/vendor sources, but no target `src/`, `extracted/` or
  build state. Independent C references can be compiled with the configured
  production toolchain and relocated using explicitly declared fixture symbols.
- `include/globals.h` supplies array/scalar-cast type evidence.
- `file-groupings.md` supplies grouping/status evidence without a game ledger.
- `branch-tail*.c` retain the compiler producer/control shapes needed to test
  orientation detection, unique jump-dump attribution and byte-exact sweeps.

Coverage includes container/symbol ownership, profile evidence, context export,
preparation/loop packets, callee signatures, static chains, verified seeds,
corpus caches, base-pointer typing and callback graphs. Temporary projects are
removed by test cleanup; the active project configuration is never rewritten.

Run `npm test` with the configured compiler/binutils/Python tools provisioned.
The suite does not require BTN assets. Optional historical original-asset tests
remain guarded and skipped without their inputs; this is not a claim that their
112 current cases have been converted or that a game/library binary matches.
Strict TypeScript checking still has inherited errors.
