# Phase 1 — Assembler recipe

Status: implemented; two clean offline builds reproduce the pinned hash and the
manifest accounts for every source file. See README Progress. Depends on: nothing. Changes only psyq-decomp.

## Goal

A reproducible, intelligible build of the assembler Sony used: GNU as as it
stood on the Cygnus/FSF trunk of 1997-03-18, the same day as the compiler
snapshot, writing little-endian ECOFF.

## Why this recipe shape

No complete period source tree is available:

- the git conversion of 1997 has stale `include/` and `bfd/` files and 55
  missing sources;
- the Cygnus developer kit source and H.J. Lu's early-1997 snapshots weren't
  found online.

The nearest complete, official tree is the binutils 2.8 release (GNU FTP; files
dated 1997-04-30). The recipe therefore presents the assembler as **"binutils
2.8, rolled back to the trunk of 1997-03-18"**. It is built only from upstream
material:

- **Base:** `binutils-2.8.tar.gz`, SHA-256
  `803733c8f748268875bfea542a55fa7cad24be9fb390d4584939f8122be97379`.
- **Rollback:** one reversal patch per upstream change made after the pin
  instant (the compiler commit `2b3600acb4ec`, 1997-03-18 18:38 UTC). Each patch
  is generated mechanically from `binutils-gdb` history and carries:
  - the upstream commit;
  - its ChangeLog entry (date, author, text);
  - the files it touches.
- **Sanitize:** remove the Cygnus `start-sanitize-*`/`end-sanitize-*` blocks
  (Toshiba R5900 and similar). Public releases ran the same step.

A file is rolled back only when its history can be verified: the git revision
current at the release date must equal the 2.8 release's copy after sanitizing,
or differ only by a documented, reviewed delta. `tc-mips.c` is already checked
(6 lines from the release, an `#ifdef` placement). Unverifiable files keep their
2.8 release content and are listed. The result is an explicit file-by-file
account of what is 1997-03-18 and what is six weeks later.

**Rollback scope.** Between the pin (1997-03-18) and the 2.8 release
(1997-04-30), 213 upstream commits changed 87 source files in `gas/`, `bfd/`,
`opcodes/` and `include/`. ChangeLogs, tests and docs are excluded from that
count. Four of the 87 take part in turning MIPS assembly into an ECOFF object:

| File | Role |
| --- | --- |
| `gas/config/tc-mips.c` | instruction handling |
| `opcodes/mips-opc.c` | instruction table |
| `bfd/ecoff.c` | ECOFF object writer |
| `bfd/coff-mips.c` | MIPS ECOFF relocations |

The other 83 belong to other CPUs, other formats or generic code.

Decision D2: roll back **all 87**, wherever the history can be verified.
Option (a), `tc-mips.c` only, remains the measured reference: `as` SHA-256
`d4ec93c0…`, 178/178 initialized-byte/relocation-site agreement. That historical
research result is not strict whole-object acceptance; the Phase 3 native
metadata gate fails (see README Progress).

- A file that cannot be rolled back, because its history is unverifiable or
  the rollback breaks the build, stays at release content. The manifest lists
  it with the reason.
- Any result that differs from the reference is a finding for the research
  note, not something to tune away.

## Work

### psyq-decomp (checked in there)

`tools/binutils-recipes/gas-19970318-psx/`, mirroring
`tools/gcc-recipes/trunk-19970318-psx/`:

- `README.md`: what is built, and why a rolled-back release (summarizing the
  research note).
- `Dockerfile`:
  - environment: `ubuntu:focal`, `gcc-multilib`;
  - downloads the release tarball and checks it by SHA-256;
  - applies the sanitize step and the rollback patches;
  - builds with `gcc -m32 -std=gnu89 -fcommon -DANSI_PROTOTYPES`, linked
    `-static`;
  - configures `--target=mipsel-ecoff`, then `make all-gas`.
- `build.sh`. Its single host fix: libiberty's own `sys_errlist`/`sys_siglist`
  declarations are disabled because glibc declares them.
- `rollback/`: generated patches (`NNNN-YYYYMMDD-<commit>.patch`, each with its
  ChangeLog header) plus `manifest.json`. The manifest records, per file in
  `gas/`, `bfd/`, `opcodes/` and `include/`:
  - status: rolled back, unchanged, or kept (unverifiable);
  - the revisions used;
  - SHA-256 hashes.
- `make-rollback.sh`: regenerates `rollback/` from a `binutils-gdb` clone. It is
  run by a maintainer with network access; the Docker build never fetches git.
- `sanitize.sh`: the block-stripping step, shared by the generator and the build.
- `expected-as.sha256`.
- `provision.sh`, `install.py`:
  - install into `build/dependencies/assembler/gas-19970318-psx/as`;
  - write a provenance record: source hashes, rollback manifest hash, binary
    hash;
  - refuse any other hash, as the compiler's `install.py` does.
- `tests/`: three tiny assembler checks:
  - `move` becomes `addu`;
  - divide-first expansion;
  - `.rdata` stays an ECOFF section.
- `notes/research/assembler-identification-1997-trunk.md`: section 5 updated
  with the shipped variant and its hash.

### Harness (checked in here)

Nothing. `toolchain.json` is not switched in this phase. The harness cannot yet
consume ECOFF objects (Phase 3).

### Local only

- `build/dependencies/assembler/…`: the installed binary and provenance record.
- `build/assembler-provenance/`: the existing evidence and exploration builds,
  which remain the research record.

## Acceptance

- `provision.sh` on a clean checkout reproduces `expected-as.sha256`. Run it
  twice from scratch to confirm the build is deterministic.
- The recipe tests pass.
- Replaying the research comparison with the provisioned binary gives 178/178
  members identical to their LNK originals, including all 763 relocations.
  Script: `build/assembler-provenance/scripts/lnk_vs_ecoff.py`.
- The rollback manifest accounts for every source file in the four directories.

## Risks

- **A wider rollback changes results.** That would mean a file outside
  `tc-mips.c` matters. It is a finding: record it in the research note and
  choose the variant the evidence supports.
- **Generated patches fail to apply** where the release carries
  release-branch-only edits. Each such file gets a reviewed delta in the
  manifest or stays at release content.
