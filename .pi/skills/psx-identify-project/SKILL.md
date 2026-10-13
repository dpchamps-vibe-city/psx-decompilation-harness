---
name: psx-identify-project
description: Identify a PlayStation project's executable, SDK, compiler/assembler candidates, container layout and ABI evidence, then configure this harness to match its assets. Use when starting a new game, importing assets, creating toolchain.json or reviewing whether existing configuration fits the original binaries.
---

# Identify and configure a PSX project

Create configuration from **this project's assets**, not from the template's
compiler defaults or the example game. Keep observations, hypotheses and
configured choices separate. Do not start matching/autoloop until the project is
configured and unresolved prerequisites are reported.

## Read first

This skill lives in `./`. Resolve these references
relative to this directory:

- [Toolchain contract and npm tasks](../../../docs/toolchain.md)
- [Remaining format/ABI assumptions](../../../docs/game-agnosticity.md)
- [Configuration schema](../../../tools/lib/toolchain.schema.json)

Run commands below from the **target repository root**, never the installed
package checkout. The installed package supplies this skill and its tools; if
the project is not scaffolded yet, run `/skill:psx-bootstrap-project` (default
`exe`, or explicitly `library`) first. Inspect each tool's usage/source before
adding options; do not invent flags or claim support for an unknown format.

## 1. Inventory inputs without modifying them

1. Ask which executable/disc/archive is authoritative, which revision/region it
   represents, and whether the user already has reliable build/SDK information.
2. List supplied files; record paths, sizes and SHA-256 hashes. Keep proprietary
   extracted inputs local under `extracted/`; never commit them. Do not fetch
   game binaries or borrow assets from another project.
3. Inspect `toolchain.json`, `configs/project-info.json`, any splat configs,
   symbol tables and overlay manifest. Record whether each item is a measured
   fact, a user assertion, or a template/default candidate.
4. Check the configured executable paths. The installed package supplies TypeScript tooling;
   `psx_prepare_tooling` prepares vendors, not compiler/system binaries. For degit
   exports, missing gitlinks require provisioning the pinned sources or a
   recursive clone. Do not bypass m2c source verification.

Keep the evidence record in a project-owned file such as
`configs/identification.md`, and reference it from
`configs/project-info.json.evidence`. Include asset hashes, commands, report
paths, conclusions, competing hypotheses and unresolved prerequisites. Do not
restore the removed game research/plan directories.

## 2. Identify the target format and address model

If `project.json` selects `relocatable-library`, read
[Library targets](../../../docs/library-targets.md). Inventory authoritative
ELF/ar inputs under `library-input/` (or explicitly selected converted inputs
under `lib/`), review every input glob and reference/owned/context header role,
and run `psx_identify_project({json: true})`. Do not require a PS-X EXE, invent RAM
addresses, create splat configs, or run image-only archive/SDK integration.
PSY-Q LIB/LNK needs a converter and recorded provenance before the ELF/ar adapter
can handle it. Continue with toolchain/evidence configuration and the library
split/profile/whole-member verification workflow in that document; preserve
unresolved prerequisites. The image-only steps below apply to linked targets.

For an EXE:

```sh
psx_inspect_exe({input: "extracted/YOUR-EXE", output: "build/identification/header.md"})
```

The explicit-file diagnostic can run before project configuration exists.
Verify PS-X EXE magic, payload extent, entry point, load address, header GP and
stack fields. A PS-X EXE's `text_size` describes its loaded payload, **not** a
proven `.text` section boundary. A zero GP field is not proof of `-G0`: inspect
startup code and addressing references. Do not assume every input is an EXE;
raw overlay/object/resource formats need their own supported parsers.

Set the main target's `target_path` and project-specific `basename` in
`configs/splat/exe.yaml` (the older `configs/splat.yaml` location is also read).
If the file is absent, create a **minimal project-owned splat header** with
paths/options appropriate to this tree and measured load facts. The bootstrap
expects a main code segment with a `subsegments:` marker. Its executable header
segment covers `0..0x800`; the loaded segment starts at `0x800` and the measured
load address. Do not copy example addresses, function boundaries or subsegments.
The current paths are `src`, `include`, `build/asm`, `build/<basename>.ld`,
`configs/symbols/exe.txt`, and build-local undefined symbol files. Consult the
installed splat version's options before writing the seed header. Missing or
ambiguous metadata is a blocker, not permission to invent sections.

## 3. Measure layout and SDK evidence

```sh
psx_identify_project({json: true})
psx_disassemble_project({})
psx_identify_project({deep: true, json: true})
```

- Shallow identification examines vendor strings and reports configured choices
  **separately**. Configuration alone must never turn `undetermined` into
  `detected`.
- Disassembly runs with and without unknown-function discovery. Bootstrap uses
  the latter to avoid phantom functions inside data. Review
  `build/sectionLayout.json` against the image and disassembly before treating
  section boundaries as established.
- Deep identification runs `psx_match_sdk_signatures` across the
  available PSY-Q signature releases and writes `build/sdkVersion.json` tied to
  the target hash. Inspect the full counts/runner-up if needed:

```sh
psx_match_sdk_signatures({})
psx_match_sdk_signatures({version: "VERSION"})
```

The most matches is a **candidate SDK release**, not proof of compiler version,
assembler release, optimization flags or a homogeneous SDK. Ties, sparse matches,
modified libraries and mixed releases need review. A version-filtered scan does
not replace the cross-version comparison report. Missing signatures/layout or an
unsupported SDK is `undetermined`, never an automatic choice of 4.7.

For original-object integration, inspect coherent original LIBs, converted ELF
objects and their provenance. Once a justified SDK candidate is configured,
`psx_prepare_sdk` provisions collision-safe member identities;
`psx_prepare_sdk({verifyPlacements: true})` checks placements against actual
objects. Missing converters, collisions and unverifiable matches are blockers,
not authority to replace bytes. The harness checkout's retained reference headers are a 4.7 input set, but
bootstrap does not copy SDK headers or objects. Supply coherent originals under
`library-input/psyq/LIB/`, headers under `library-input/psyq/INCLUDE/`, and converted objects
under `lib/` (or configure other paths). First-time non-colliding conversion is
performed for supported inputs by the SDK repair tool. Changing only `sdk.version` does not turn
an input set into another release.

## 4. Identify containers and ABI assumptions

Skip archive discovery if the project has no overlays. For supported paired-index
archives only, and with the user's intended input pair established:

```sh
psx_disassemble_project({archives: true})
psx_inspect_container_abi({})
```

This adapter discovers/extracts/classifies members, solves bases and publishes
`configs/overlays.json`. It is **not a universal PS1 archive decoder**. Inspect
`psx_extract_archive` for explicit `index`/`data` selection when
more than one pair is plausible. Unknown formats need an adapter, not guessed
boundaries. Unresolved bases remain unresolved and must not be claimed verified.

Measure GP-relative references, section placement, endianness, calling/struct
return conventions and macro/assembler expansion behavior for each container
where evidence exists. Zero GP-relative accesses does not by itself identify a
unique `-G` threshold. The current overlay model also assumes zero GP and
`ovl_NN` ownership prefixes; call out any conflicting asset evidence as work to
generalize instead of changing flags to hide it.

## 5. Write justified configuration

Edit `toolchain.json` using its existing schema:

- `tools`: verified local executable/script paths; one path per field, not a
  shell command. Root-relative paths make the clone/export portable.
- `compiler.family`, `version`, `source`, `capabilities`: available **candidate**
  compiler and genuinely supported forensic adapters. GCC source/trace/oracle
  tools cannot identify another compiler by reading the bundled GCC sources.
- `includeDirs`, `flags.cpp`: coherent project/SDK declarations and definitions.
- `flags.cc1`, `as`, `ld`, `maspsx`: candidate base arrays justified by target
  fingerprints and comparison. The shipped `-O2 -G8`, GCC 2.95.2 and ASPSX 2.80
  are not universal PSX facts.
- `sdk`: coherent version-specific original, converted and signature inputs.
- `profiles`, `containerProfiles`: explicit container/kind selection when
  measured behavior differs. Profiles replace complete cc1/as/ld/maspsx arrays;
  omitted arrays inherit base. Never rely on an automatic `-G8` → `-G0` swap.
- `configs/flag_overrides.mk`: leave empty without per-TU target fingerprints, dominant probe
  evidence, no contrary regional witness and a matching policy allowlist.
  Ordinary workers must not modify toolchain authority.

Do not select flags solely to improve a score. Use representative **real target
functions** and the normal relocated-byte oracle when validating a candidate;
a synthetic compiler smoke test only proves that tools run. Full-container byte
identity validates resulting output, not unique historical compiler identity.
Keep unsupported compiler drivers/SDKs/ABI patterns explicit; configuration does
not create an adapter that is not implemented.

## 6. Validate and hand off

With prerequisites present:

```sh
psx_split_project({all: true})
psx_verify_project({})
psx_generate_project_profile({write: true})
psx_project_progress({})
```

For a relocatable-library project, also run the established end-to-end check
from [Library targets](../../../docs/library-targets.md):

```sh
npm run library -- check-splits
npm run library -- preflight 'MEMBER_ID::Symbol'
```

Choose a real mixed member with private callees/shared storage, not just an
already-working tiny leaf. SDK preprocessing, relocation-aware boundaries,
whole-member identity and m2c generation must all be measured before model
dispatch. Keep draft compilation/exactness separate from setup success; a
split-fidelity pass does not certify live C. On case-sensitive hosts verify
DOS header casing and prevent host headers from silently supplying SDK includes.

For selected containers, use `psx_split_project({container: "ID"})` and
`psx_verify_project({container: "ID"})`. Keep validation lean; do not build a large
new test suite to onboard a project. `psx_check_configuration` is useful once a Git
baseline exists, but guards tracked config/header convergence only.

Hand off:

1. Input identities and evidence/report paths.
2. Configured choices and why each follows (or is only a candidate).
3. Successful commands and exact verification scope.
4. Unresolved findings, missing tools/assets and adapters needing generalization.

Without enough assets to split/build, deliver a clearly labelled **partial
configuration** and blockers. Never claim complete verification, silently skip
containers, enable autonomous commits, or import another game's approvals.
