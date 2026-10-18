# Phase 6 — Switch-over and full re-verification

Status: configurations prepared and the real staged check-all CLI exercised;
the native gate fails. Production selection and records remain unchanged. Depends on: Phases 1–5.

## Goal

psyq-decomp runs on the period toolchain and exact original-object
verification, with every member re-verified. This is the only phase that
changes psyq-decomp's production configuration.

## Work

### psyq-decomp (checked in there)

- **`toolchain.json`:**
  - `tools.cpp` → period `cccp`; `tools.cc1` (unchanged); `tools.as` → period
    GNU as;
  - `assembler: { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx"] }`;
  - `flags.as`: `-EL -G0 -mips1`;
  - `flags.cpp`: reviewed for `cccp`.
- **`project.json`:** `verification: { mode: "original-object", originals: … }`.
- **Regenerated:** `configs/project-profile.md`.
- **Notes:**
  - `notes/research/assembler-identification-1997-trunk.md`: shipped recipe,
    final hashes, results;
  - `configs/toolchain-identification.md`: interim wording replaced;
  - prnt's park note: closed, since the member now matches.
- **The `sn-aspsx` profiles in `toolchain.json`:** reviewed. They served
  `Libsn.lib`, which the project dropped. Remove them, or document why they
  stay.

### Harness (checked in here)

- No new code in this phase. Release notes, and instruction snapshots if
  Phases 3–5 changed agent-facing text.

### Local only

- **Old verified records** (decision D6): delete all 2,224, including the 57
  for dropped `Libsn` members. Nothing is archived; `npm run check-all` writes
  new records.
- Phase 7 replaces these records again under the new member IDs.

## Sequence

1. Confirm the autoloop is stopped.
2. Provision the recipes (Phases 1 and 2) and check their hashes.
3. Apply the configuration changes in one change set.
4. Run `npm run check-all`. The target is 2,167/2,167 exact against the
   originals, with prnt included.
5. Investigate each failure to its mechanism. Never loosen the comparator.
6. The user reviews and commits. The autoloop stays stopped until Phase 7 has
   renamed the members.

## Acceptance

- `check-all`: 2,167/2,167 exact under the original-object oracle.
- Zero `inputRewrites`; zero masking; zero copied relocation tables.
- Every record carries plaintext tool hashes (cpp, cc1, as) and stage
  identities.
- A finalize run from the autoloop on a fresh target goes through the same path
  and records the same provenance.
