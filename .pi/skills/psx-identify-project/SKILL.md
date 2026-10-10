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

This skill lives in `.pi/skills/psx-identify-project/`. Resolve these references
relative to this directory:

- [Toolchain contract and npm tasks](../../../docs/toolchain.md)
- [Remaining format/ABI assumptions](../../../docs/game-agnosticity.md)
- [Configuration schema](../../../tools/lib/toolchain.schema.json)

Run commands below from the **repository root**, three directories above this
skill. Inspect each tool's usage/source before adding options; do not invent
flags or claim that a detector supports an unknown format.

## 1. Inventory inputs without modifying them

1. Ask which executable/disc/archive is authoritative, which revision/region it
   represents, and whether the user already has reliable build/SDK information.
2. List supplied files; record paths, sizes and SHA-256 hashes. Keep proprietary
   extracted inputs local under `extracted/`; never commit them. Do not fetch
   game binaries or borrow assets from another project.
3. Inspect `toolchain.json`, `configs/project-info.json`, any splat configs,
   symbol tables and overlay manifest. Record whether each item is a measured
   fact, a user assertion, or a template/default candidate.
4. Check the configured executable paths. `npm ci` installs TypeScript tooling;
   `npm run setup` prepares vendors, not compiler/system binaries. For degit
   exports, missing gitlinks require provisioning the pinned sources or a
   recursive clone. Do not bypass m2c source verification.

Keep the evidence record in a project-owned file such as
`configs/identification.md`, and reference it from
`configs/project-info.json.evidence`. Include asset hashes, commands, report
paths, conclusions, competing hypotheses and unresolved prerequisites. Do not
restore the removed game research/plan directories.

## 2. Identify the executable and address model

```sh
npx tsx tools/diagnostics/headerInfo.ts extracted/YOUR-EXE build/identification/header.md
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
npm run identify -- --json
npm run disassemble
npm run identify -- --deep --json
```

- Shallow identification examines vendor strings and reports configured choices
  **separately**. Configuration alone must never turn `undetermined` into
  `detected`.
- Disassembly runs with and without unknown-function discovery. Bootstrap uses
  the latter to avoid phantom functions inside data. Review
  `build/sectionLayout.json` against the image and disassembly before treating
  section boundaries as established.
- Deep identification runs `tools/diagnostics/matchSignatures.ts` across the
  available PSY-Q signature releases and writes `build/sdkVersion.json` tied to
  the target hash. Inspect the full counts/runner-up if needed:

```sh
npx tsx tools/diagnostics/matchSignatures.ts
npx tsx tools/diagnostics/matchSignatures.ts --version VERSION
```

The most matches is a **candidate SDK release**, not proof of compiler version,
assembler release, optimization flags or a homogeneous SDK. Ties, sparse matches,
modified libraries and mixed releases need review. A version-filtered scan does
not replace the cross-version comparison report. Missing signatures/layout or an
unsupported SDK is `undetermined`, never an automatic choice of 4.7.

For original-object integration, inspect coherent original LIBs, converted ELF
objects and their provenance. Once a justified SDK candidate is configured,
`npm run split-sdk-libs` provisions collision-safe member identities;
`npx tsx tools/build/detectLibFunctions.ts` checks placements against actual
objects. Missing converters, collisions and unverifiable matches are blockers,
not authority to replace bytes. The retained headers/objects are a 4.7 input set;
changing only `sdk.version` does not turn them into another release.

## 4. Identify containers and ABI assumptions

Skip archive discovery if the project has no overlays. For supported paired-index
archives only, and with the user's intended input pair established:

```sh
npm run disassemble -- --archives
npx tsx tools/diagnostics/overlayFlagFingerprint.ts
```

This adapter discovers/extracts/classifies members, solves bases and publishes
`configs/overlays.json`. It is **not a universal PS1 archive decoder**. Inspect
`tools/build/extractArchive.ts` for explicit `--index`/`--data` selection when
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
- `fileFlags`: leave empty without per-TU target fingerprints, dominant probe
  evidence, no contrary regional witness and a human-approved policy allowlist.
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
npm run split-all
npm run check-all
npx tsx tools/build/genProjectProfile.ts --write
npm run progress
```

For selected containers, use `npm run split -- --container ID` and
`npm run check -- --container ID`. Keep validation lean; do not build a large
new test suite to onboard a project. `npm run config-check` is useful once a Git
baseline exists, but guards tracked config/header convergence only.

Hand off:

1. Input identities and evidence/report paths.
2. Configured choices and why each follows (or is only a candidate).
3. Successful commands and exact verification scope.
4. Unresolved findings, missing tools/assets and adapters needing generalization.

Without enough assets to split/build, deliver a clearly labelled **partial
configuration** and blockers. Never claim complete verification, silently skip
containers, enable autonomous commits, or import another game's approvals.
