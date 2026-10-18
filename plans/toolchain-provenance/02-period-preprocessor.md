# Phase 2 — Period preprocessor

Status: proposed. Depends on: nothing.

## Goal

Preprocessing uses the C preprocessor that shipped with the pinned compiler
source: GCC trunk 1997-03-18's `cccp`, not the host's GCC 12
`mips-linux-gnu-cpp`. It is pinned and hashed like `cc1`. Its output text feeds
`cc1` and, from Phase 5, Sony-style assembly sources.

## Current state

- `toolchain.json` `tools.cpp` is `mips-linux-gnu-cpp`. On this host that is
  GCC 12.4.0.
- The harness uses `cpp` for two different jobs:
  - **Production preprocessing**, which produces the `.i` text that `cc1`
    compiles:
    - `tools/agent/decompToolchain.ts` (`compileSource`, `preprocessOnly`);
    - `tools/build/pipeline.ts` (EXE route);
    - `tools/agent/preprocessedCache.ts`;
    - `tools/build/classifyGlobals.ts`.
  - **Dependency discovery and tool probing**, which never produces compiled
    text:
    - `-MM -MG` in `decompToolchain.ts`;
    - `-MD -MP -MF -MT` in `pipeline.ts`;
    - `-print-prog-name` in `tools/lib/toolchain.ts`.
- 1997 `cccp` supports `-M`/`-MM`/`-MG`. It lacks `-MP`/`-MT` and
  `-print-prog-name`.

## Work

### psyq-decomp (checked in there)

- `tools/gcc-recipes/trunk-19970318-psx/`: also build `cccp` from the same
  pinned source; it is part of the same GCC tree. Add `expected-cpp.sha256`.
  Install it next to `cc1`, and record both in the provenance record.
- `toolchain.json`:
  - `tools.cpp` points at the installed `cccp`;
  - check `flags.cpp` (`-undef -D__GNUC__=2 -lang-c -D_LANGUAGE_C …`) against
    what 1997 `cccp` accepts, and drop anything only the modern `cpp` needed.
  - Switched in Phase 6, or earlier once the harness side lands.

### Harness (checked in here)

- Split the two jobs explicitly:
  - **Production preprocessing** uses `tools.cpp` and is part of the
    compilation identity, as now.
  - **Dependency discovery** may use a separate scanner: a new optional
    `tools.dependencyScanner`, defaulting to `tools.cpp`, or the harness's own
    content-cached scanner. It never produces compiled text, so it stays out of
    the byte path. The identity only records which scanner ran.
- Replace the `-print-prog-name` probe with something `cccp` doesn't need to
  support. One option is to hash the configured binary directly.
- Update `tools/lib/toolchain.schema.json` and `docs/toolchain.md`.
- Tests, synthetic:
  - a fake preprocessor that lacks `-MP`/`-MT` still builds with a separate
    scanner;
  - the identity changes when the production preprocessor changes, and not
    when only the scanner changes.

### Local only

The built `cccp` under `build/dependencies/compiler/…`.

## Acceptance

- psyq-decomp compiles every C-bearing member with the period `cccp`. For each
  member, compare the resulting object with the GCC 12 `cpp` build. Expected
  result: zero byte differences. Any difference is a finding, recorded in the
  compiler research note, not patched over.
- `cccp`'s hash is recorded in the compilation identity and in the provenance
  record.

## Risks

- **Old `cccp` rejects a flag or syntax** used by project headers, such as
  `//` comments or a modern `#pragma`. Fix the header, which is project source,
  not the preprocessor.
- **Macro expansion differs** between `cccp` and GCC 12 in a way that changes
  code. That would mean today's matches depend on the modern preprocessor:
  re-verify, then record the result.
