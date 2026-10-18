# Phase 4 — GTE stage (DMPSX-equivalent)

Status: implemented; 192/192 real HMD sources compile and their initialized
bytes/relocation sites agree after 915 replacements. Full native metadata checks
do not establish acceptance, so the whole-object requirement remains open.
The former alignment mismatch was a reader bug; unencoded ECOFF alignment is
now reported as unavailable, separately from witnessed section differences. Depends on: Phase 3, for the ECOFF model.

## Goal

Reproduce Sony's DMPSX step with a native, declared, validated stage, so that
GTE (geometry coprocessor) code can be written the way Sony wrote it.

## Evidence

The SDK ships Sony's `libhmd` sources: 192 `.ASM` and 163 `.C` files. Its readme
says they are "completely the same as those used in SCEI to create libhmd".
Sony's makefile builds each one in two steps:

```
00000008.obj: 00000008.asm
	$(CC) $(CFLAGS) -c 00000008.asm -o 00000008.obj
00000008.o2: 00000008.obj
	$(DMPSX) -o 00000008.o2 00000008.obj
```

Research result. Each of the 192 sources was preprocessed with the SDK's own
headers and assembled with the identified 1997 assembler. Compared with the
shipped `libhmd` members:

- every section size and every relocation is identical;
- every byte is identical except 915 words.

Those 915 words are exactly the GTE placeholders that `inline_s.h` macros emit,
which DMPSX turns into real COP2 instructions:

| Kind | Count | Example |
| --- | ---: | --- |
| Simple placeholders | 887 | `0x000000bf` → `0x4a280030` (`RTPT`) |
| Placeholders with operand fields | 28 | `0x027813bf` → `0x4a49e012` (`MVMVA`) |

There are 13 distinct pairs in all.

## Stage definition

The rule is not a table fitted to target bytes. It comes from the SDK's GTE
headers (`INLINE_S.H` and `INLINE_C.H` define the placeholder words) and the
COP2 command encoding.

- **Input:** an assembled candidate object.
- **Operation:** in executable sections only, replace each word that matches
  the DMPSX placeholder encoding with its COP2 command word, carrying operand
  fields across. Placeholder words never carry relocations; a relocated
  placeholder is an error.
- **Fail closed:** an unrecognized placeholder value is an error, never passed
  through.
- **Identity:**
  - the stage has a name (`psyq-dmpsx`) and a version;
  - the hash of its implementation file joins the compilation identity;
  - every replacement (section, offset, placeholder, result) is written to the
    member's receipt.
- **Declared, not implicit:** it runs only when `toolchain.json` lists it, for
  example `assembler.postAssembly: ["psyq-dmpsx"]`. With no declaration,
  nothing runs.

## Work

### Harness (checked in here)

- `tools/lib/stages/psyqDmpsx.ts`: the stage, operating on the Phase 3 object
  model. It writes the candidate object with the replacements and records
  them.
  - Placement: the harness, because DMPSX is a PSY-Q SDK tool and every
    PSY-Q-era project that uses GTE macros needs it, not just psyq-decomp. It is
    SDK behavior, not consumer data.
- `tools/lib/toolchain.schema.json`: `assembler.postAssembly`, with a closed
  list of known stage names. `tools/lib/assembler.ts` runs declared stages after
  `as`, and the stages join `assemblerIdentity`.
- `docs/toolchain.md`:
  - which period tool the stage reproduces;
  - how its rule was derived;
  - that a stage is not a rewrite channel: closed list, period-tool basis,
    validation corpus required.
- Tests, synthetic: every command and operand field from the documented
  encoding; an unknown placeholder fails; a relocated placeholder fails; words
  outside executable sections are untouched; an undeclared stage is not run.
- Harness `include/gte_macros.inc` ("meant for use with GAS and replace DMPSX")
  stays available to projects that don't use the stage. Bootstrap copies it, so
  record its status in the scaffold docs (Phase 5).

### psyq-decomp (checked in there)

- `toolchain.json`: `assembler.postAssembly: ["psyq-dmpsx"]`. Switched in
  Phase 6.
- `notes/research/assembler-identification-1997-trunk.md`: new section with the
  HMD validation (method, results, the 13 pairs).
- An audit of GTE use in C. Today no C member includes `inline_c.h` and 606
  files use the project's `gte_macros.inc` or `inline_a.inc`. Decide per header
  whether it moves to the SDK macros plus the stage (Phase 5).

### Local only

- Sony's HMD sources: copy them from the SDK distribution into git-ignored
  `library-input/psyq/SRC/LIB/HMD`, recording their hashes in the research note.
- Validation outputs under `build/assembler-provenance/hmd/`.

## Acceptance

- 192/192 HMD sources reproduce their shipped `libhmd` members exactly through
  the full chain (cpp → as → `psyq-dmpsx`), compared against the LNK originals.
- Every placeholder value in the HMD corpus is recognized. The stage replaces
  nothing in members that contain no placeholders.

## Risks

- **DMPSX does more than the HMD corpus shows**, for example placeholder forms
  only C macros produce. Extend validation to every SDK GTE macro before
  relying on it, and keep fail-closed.
- **Scope creep into a general rewrite hook.** A stage is admitted only with a
  named period tool and a validation corpus. Each new stage needs the same
  review as a toolchain change.
