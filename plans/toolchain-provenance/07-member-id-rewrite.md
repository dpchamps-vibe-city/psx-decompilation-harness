# Phase 7 — Member ID rewrite (final step)

Status: inventory and transactional migration implemented; a full staged preview
covers 2,167 active IDs and runtime state. Reference-only preparation accounts
for the excluded Libsn history. Write refuses without Phase 6 native matches;
production IDs and the stopped loop remain unchanged. Depends on: Phase 6.

## Goal

End with one identity scheme, derived from the original SDK objects. The
original LNK members become the project's inventory, and their IDs are the
member IDs. The converted ELF files become a per-member view for disassembly
and m2c, and no ID refers to them.

Every member is then re-verified under the new IDs. Those records replace the
Phase 6 records, and the autoloop resumes.

## Why last

The work in Phases 3–6 keeps the existing IDs. Each one is
`lib_<sha256(converted ELF path)[:16]>_<ordinal>`, and links to its original
through a content-checked mapping. Renaming in the middle would mix two schemes
across a long change. Doing it last means:

- the toolchain switch is proven first, under unchanged names;
- the rename is a single mechanical step;
- re-verification shows that nothing but names changed.

## New ID scheme

Proposed: `<archive stem>_<ordinal>`, lowercased. Standalone `.OBJ` files use
their stem.

| Original | New ID |
| --- | --- |
| `LIBC2.LIB` member 33 | `libc2_33` |
| `NOPRINT.OBJ` | `noprint` |

- **Readable and stable.** It names the original directly, and the original
  never changes.
- **Unique.** Ordinals are unique within an archive and archive stems are
  unique; the harness enforces both.
- **Same as the directories.** `src/libraries/libc2/33-prnt/` already uses
  archive + ordinal + member name, so directories don't move.
- **Target keys follow.** `lib_c111b0bc4de489f7_0::prnt` becomes
  `libc2_33::prnt`.

## Work

### Harness (checked in here)

- **Originals as the inventory.** A new library target format,
  `target.format: "psyq-lib"`, enumerates members from the original
  `.LIB`/`.OBJ` files with the Phase 3 LNK reader, and derives IDs as above.
- **The ELF view.** `views.elf` gives each member's converted ELF for
  disassembly and m2c, validated against the original by content as in Phase 3.
- **The transitional mapping is retired.** Phase 3's
  `verification.originals` is removed, because the inventory is now the
  originals.
- **Migration command** (`library.ts migrate-member-ids`):
  - it computes the old→new table from the two inventories;
  - dry-run by default, listing every file and occurrence it would change;
  - `--write` applies it to:
    - project sources (the `INCLUDE_ASM` paths, TU manifests);
    - notes and configs;
    - the runtime state the harness owns: autoloop state and attempts, keyed
      by target;
  - it refuses if any new ID collides, any old ID would remain, or any member
    fails to map.

  It is generic: any library project moving its inventory to originals can use
  it.
- **ID derivation** in `tools/lib/libraryTargets.ts` for the new format;
  schema and `docs/library-targets.md` updated.
- **Tests, synthetic:** ID derivation and uniqueness; the migration dry-run and
  write on a fixture project, including runtime state; refusal cases.

### psyq-decomp (checked in there)

- **`project.json`:**
  - `target` lists the originals: `library-input/psyq/LIB/*.LIB` and the
    standalone `.OBJ` files;
  - `views.elf` points at `library-input/redux`;
  - `verification.mode: "original-object"`, with no separate originals map.
- **The rewrite, applied by the migration command:**
  - `src/libraries` (4,758 files contain IDs);
  - 19 notes and approval files;
  - `configs/compatibility-correction.md`;
  - `plans/harness-rdata-section-rewrite.md`;
  - regenerated `configs/project-profile.md`.
- **Old IDs remain only in git history,** including commit messages such as
  "park lib_44f881123df2c306_0::sprintf". Optionally keep one historical
  lookup, `notes/member-id-migration.json` (old → new), so those messages stay
  traceable. It would be the only file containing old IDs, and is omitted if
  not wanted.

### Local only

- **Autoloop state** (`run_output/autoloop/state.json` and `attempts/`):
  rewritten by the migration command so park/defer decisions and completions
  carry over.
- **Verified records:** the Phase 6 records are deleted; `npm run check-all`
  writes new ones under the new IDs.
- **Stubs and candidates:** `build/libraries/nonmatchings/`,
  `build/libraries/candidates/` and preparation packets are deleted and
  regenerated.

## Sequence

1. With the autoloop stopped, run the migration dry-run and review the change
   list.
2. Apply it, together with the `project.json` change.
3. Check that no old-format ID (`lib_[0-9a-f]{16}_N`) remains in project files,
   apart from the optional lookup file.
4. Delete the verified records and generated build state, then run
   `npm run check-all`.
5. Resume the autoloop.

## Acceptance

- Zero old-format IDs in tracked project files and in local runtime state,
  apart from the optional lookup.
- `check-all`: 2,167/2,167 exact. Each member's verdict and compared content
  equal its Phase 6 result under the old ID, mapped through the table.
- The autoloop selects, prepares and finalizes a fresh target under the new IDs
  and keeps the existing park/defer decisions.
