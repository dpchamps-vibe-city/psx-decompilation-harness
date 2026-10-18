# Phase 3 — Original-object verification

Status: proposed. Depends on: Phase 1, for the opt-in real-project check only.

## Goal

Library acceptance compares the candidate object produced by the period
assembler (ECOFF) against the original SDK object (PSY-Q LNK), exactly. No
format conversion is applied on either side. The converted ELF files keep their
role as member inventory and disassembly input, and leave acceptance.

The research shows this works: 178/178 members identical, including all 763
relocations. The 2.8 release, as a negative control, fails on exactly its six
known members.

## Current state

- **Acceptance:** `checkLibrary` (`tools/agent/libraryTarget.ts`) compiles a
  member and calls `compareRelocatableObjects` (`tools/lib/relocatableObject.ts`)
  against `member.bytes`. Those bytes are the converted ELF from
  `project.json` `target.standaloneObjects`.
- **The comparator:**
  - folds defined references (`canonicalizeDefinedReferences`);
  - ignores section alignment, write flags and `e_flags`;
  - wildcards symbol type and size when the target has `NOTYPE` or size 0.

  These exist to tolerate artifacts of the ELF conversion.
- **Member IDs** are `lib_<sha256(converted path)[:16]>_<ordinal>`
  (`tools/lib/libraryTargets.ts`).
- **The only path to the original object** is the LNK *packaging* census in
  `tools/diagnostics/assemblerEvidence.ts`, which skips payloads, plus
  `readPsyqLib` in `tools/lib/psyqMembers.ts`.
- **The assembler** is `tools/lib/assembler.ts`, with `inputRewrites`; ELF
  output is assumed everywhere.

## Work

### Harness (checked in here)

#### Object readers

`tools/lib/objectFormats/`:

- **`lnk.ts`:** a complete PSY-Q LNK v2 reader. It handles:
  - code (2), section switch (6) and uninitialized data (8);
  - patch (10), with the full expression tree;
  - XDEF and XREF (12, 14), local symbols, section definitions (16) and
    alignment;
  - file and processor records.

  Every record outside the specified grammar is an error. This replaces the
  skip-only reader in `assemblerEvidence.ts`, which then uses it.
- **`ecoff.ts`:** a MIPS little-endian ECOFF relocatable reader. It handles:
  - file and section headers;
  - relocations: REFHALF, REFWORD, JMPADDR, REFHI, REFLO, GPREL, LITERAL;
  - external and local symbols from the symbolic header.
- **`model.ts`:** both readers produce one model of sections, relocations and
  symbols, with no conversion: both formats keep in-place addends in
  section-layout form. The ELF reader in `relocatableObject.ts` stays for
  disassembly views.

#### Exact comparator

`compareOriginalObject(original, candidate)` checks all of the following, with
no masking, folding or wildcards:

| What | Compared by |
| --- | --- |
| Sections | names, kind, size, alignment |
| Bytes | every byte, relocated fields included |
| Uninitialized sizes | value |
| Relocations | section, offset, kind and target |
| Defined externals | name, section, offset |
| Undefined externals | name |
| COMMON | name and size |

It reports every difference and returns MATCH only when there are none.

#### Configuration

- `tools/lib/project.schema.json`: add
  `verification: { mode: "original-object", originals: { format: "psyq-lnk", archives, objects, map } }`.
  - `map` resolves each member to its LNK member by archive and ordinal; a
    conversion report can drive it.
  - Before use, each pairing is validated by content: the converted ELF's
    section bytes must equal the LNK's outside relocated fields, at the same
    relocation sites.
  - A member with no original, or a failed check, is an error.
  - `relocatable-object` mode stays for projects without originals.
  - The mapping is transitional: it lets Phases 3–6 keep today's member IDs.
    Phase 7 makes the originals the inventory, rewrites the IDs, and removes
    the mapping.
- `tools/lib/toolchain.schema.json`:
  - `assembler: { kind: "gas", objectFormat: "elf" | "ecoff" }`, defaulting to
    `elf`;
  - **remove `inputRewrites`.**

#### Assembler

- `tools/lib/assembler.ts`: delete `rewriteAssemblerInput`, the
  `move-addu`/`rdata-section` IDs and the `.as-input.s` copy. The assembler
  input is the compiler's output file, unchanged. Record its hash.
- `tools/lib/toolchain.ts`: remove `ASSEMBLER_REWRITES`.

#### Acceptance path

- **`checkLibrary`, `compileMember` and `libraryVerificationMembers`:** use the
  original and the candidate object. This is the path `library.ts check
  --member`, finalization (`.pi/extensions/shared/gates.ts`) and `check-all`
  run through.
- **Diagnostics read the same model, so they cannot disagree with acceptance:**
  - `tools/agent/diffFunc.ts` / library `diff`;
  - the residual objective;
  - `tools/lib/relocatableFunctionOracle.ts`;
  - `tools/agent/contextExport.ts`;
  - `tools/agent/libraryPreflight.ts`.

  m2c and spimdisasm keep reading the converted ELF.

#### Provenance records

- Accepted records gain a plaintext `toolchain` block:
  - `cpp`, `cc1` and `as` with their SHA-256 hashes;
  - the recipe pins;
  - the object format;
  - the identity of each declared stage (Phase 4).
- Keep the assembler receipt of accepted members (small JSON) instead of
  deleting it with the candidate directory.
- `tools/lib/cacheIdentity.ts`: the original member's hash and the object
  format join the identity.

#### Docs and tests

- Docs:
  - `docs/toolchain.md`: assembler section rewritten; the rewrites section
    removed;
  - `docs/library-targets.md`: original-object verification.
- Agent-facing instructions that mention the oracle or the rewrites: update
  them through `npm run test:update-instructions`.
- Tests, synthetic and game-agnostic:
  - hand-built LNK and ECOFF fixtures for each reader, with truncation and
    unknown-record cases;
  - comparator negative controls: a flipped byte, a moved relocation, a changed
    relocation kind, a renamed section, a changed alignment, a missing or extra
    symbol, a different COMMON size;
  - failure of the pairing validation;
  - removal of `inputRewrites`: the schema rejects the key.
- An opt-in real-project check, guarded like
  `tools/testing/installedRuntimeTimings.ts`, runs `check --member` on a
  configured project.

### psyq-decomp (checked in there)

Prepared in this phase and switched on in Phase 6:

- `project.json`: `verification` becomes
  `{ mode: "original-object", originals: { … library-input/psyq/LIB … } }`.
  `target.standaloneObjects` is unchanged, so member IDs are unchanged.
- `toolchain.json`:
  - `tools.as` points at the Phase 1 binary;
  - `flags.as` becomes `-EL -G0 -mips1`;
  - `assembler.objectFormat` becomes `"ecoff"`;
  - `inputRewrites` is deleted.

### Local only

- The original SDK `.LIB`/`.OBJ` files already sit in git-ignored
  `library-input/psyq/LIB`.
- Verified records under `build/libraries/verified`.

## Acceptance

- Through the real `check --member` path, the 178 members verified in research
  pass. The 2.8 binary, as a negative control, fails on exactly six.
- Every comparator negative control fails, naming the difference.
- The pairing validation succeeds for all 2,167 psyq-decomp members.
- EXE projects and ELF-only library projects behave as before.

## Risks

- **The LNK grammar has records or expression forms not yet seen.** The reader
  fails closed. Survey all 2,230 SDK objects before switching.
- **Diagnostics assume ELF in places the readers don't cover.** Inventory every
  use of `readRelocatableObject`, `compareRelocatableObjects`, `member.bytes`
  and `member.object` (22 non-test files today) and give each a decision:
  acceptance model, or ELF view.
