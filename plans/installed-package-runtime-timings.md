# Installed-package runtime acceptance timings

Status: PASS for every required scenario. All wall times below are seconds;
all repetitions are shown, not just the fastest result.

## Revisions, installation and host

- Protected instruction baseline: `fdedbe9f68cce6de7a5811e7b05ff32fd74bf601`.
- Performance baseline: btn-decompilation HEAD `5bf2f1d2791cad57cfd03067d44f67db1339165e`,
  recorded before production runtime/orchestration changes.
- Harness source at measurement: HEAD `ccc5cd2aa2ed9c484d0f789e6660bf58d2838401` plus the
  uncommitted installed-runtime implementation. The package fingerprint below
  identifies the exact measured implementation; HEAD alone does not.
- Production package: `psx-decompilation-harness-1.0.0.tgz`, version
  `1.0.0`, SHA-256
  `9e12d1b84c8b92ac6c606ea2e8fd9e6a51f0a0dd805bdd77bafb774ca639ba16`.
- Node `v24.1.0`; actual Pi host 0.85.1; Linux x86-64,
  Intel Core i9-12900K. GNU Make 4.3 for the baseline.
- Separate disposable baseline/harness workspaces:
  `/tmp/psx-installed-runtime-hhGRv2/{baseline,harness}`.
- Installed implementation:
  `/tmp/psx-installed-runtime-prod-LwDaUn/runtime/node_modules/psx-decompilation-harness`.
  Consumer dependencies are the production-only installation; peers resolve
  through the supported Pi host loader. No project-local implementation exists.
- Complete host/environment, exact tool paths, translated configuration,
  per-original/input hashes and package identity:
  `build/installed-runtime/baseline-environment.json` and
  `build/installed-runtime/timings-final/environment.json`.

Original EXE SHA-256: `34e3b35dcd3fb1cd9a7d4813b8a9ef987915826e3d436f1908ecbe2d4fdf1444`.
Configured compiler SHA-256:
`2aa85925dfa10855107c78e29ec36965b953976a45b1a47fb68beb5a74096079`.
Applicable override-file SHA-256:
`b5f7806b9b667c49c35b2338cd7ac3a4bdfde0743a1cb886ecc917109454a115`.
Complete supplied-input inventory SHA-256:
`3c222832f9b5ca2b6df9e256fde4693d476ccc3d9440234cb4cff20a30f45e8b`.
Translated toolchain SHA-256:
`24e8bc78508fdc85181b61b7a014b4291d3a13444549750093d7e0c795ef7de9`.

The harness clone retains the baseline compiler, binutils, maspsx, headers and
per-TU overrides. EXE flags retain -G8; the overlay profile replaces cc1/as
small-data flags with -G0, without changing maspsx flags. All supplied SDK
originals/headers are explicitly configured under the clone's library-input;
private lib objects remain project data. The sibling game repository was not
modified. The harness-side clone has no copied tools/extensions/skills; real
Pi registration provenance is checked and duplicate names fail the measurement.

## Comparison rule and results

The rule was recorded in timings-final/environment.json before the corrected
series: **every harness repetition must be at or below the baseline median plus
the baseline three-run range (maximum minus minimum), for that scenario**.
Harness variation does not enlarge tolerance. Calculations use full precision;
displayed values are rounded. Baseline noise is measured, not an arbitrary
percentage. No slower final scenario is excused by averages or selected runs.

| Scenario | Baseline repetitions | Harness repetitions | Baseline noise | Acceptance ceiling | Verdict |
| --- | --- | --- | --- | --- | --- |
| Cold split-all + check-all | 204.241 / 208.320 / 206.148 | 196.721 / 204.908 / 205.428 | 4.079 | 210.227 | PASS |
| Warm all-container no-op | 3.245 / 3.498 / 3.286 | 1.898 / 1.942 / 1.948 | 0.253 | 3.540 | PASS |
| EXE source touched + check-all | 14.798 / 14.781 / 14.774 | 1.875 / 1.916 / 1.948 | 0.025 | 14.806 | PASS |
| Overlay source touched + check-all | 3.886 / 3.987 / 3.943 | 1.906 / 1.936 / 1.948 | 0.101 | 4.043 | PASS |
| Executable-only verification | 2.947 / 3.040 / 2.870 | 0.563 / 0.559 / 0.566 | 0.171 | 3.118 | PASS |
| Complete function finalization | 14.508 / 14.597 / 14.564 | 11.232 / 11.196 / 11.531 | 0.089 | 14.653 | PASS |
| Residual objective, cold caches | 2.205 / 2.151 / 2.220 | 2.126 / 2.146 / 2.176 | 0.069 | 2.275 | PASS |
| Residual objective, warm caches | 2.121 / 2.120 / 2.112 | 1.992 / 2.063 / 2.094 | 0.008 | 2.128 | PASS |
| One-function preparation | 9.099 / 8.129 / 8.697 | 7.229 / 7.605 / 7.580 | 0.969 | 9.667 | PASS |

## Exact operations and starting states

The baseline uses `make split-all`, `make check-all` and `make check` with
its explicitly configured converter. The harness uses the installed build API
through its internal absolute-script dispatch, with explicit project context;
this is implementation plumbing, not a new agent runner or copied tool tree.
Existing provided tools perform finalization, residual measurement and preparation.

- Cold full: restore disposable tracked src/include/configs to the fixed clone
  HEAD; empty build; then split-all followed by check-all, timed together.
  Restore/preserve durable research records rather than clearing their contents.
- Warm no-op: check-all with the immediately preceding successful artifacts.
- EXE touch: touch src/CopyVec3.c, preserving bytes, then check-all.
- Overlay touch: touch src/overlays/ovl_31/ovl_31_func_800B8600.c, preserving
  bytes, then check-all. Content-based freshness legitimately avoids recompiling
  an unchanged-byte touch while still comparing every original container.
- Executable only: baseline check versus installed executable verification,
  with the same current artifact state.
- Finalize: actual psx_finalize_function for CopyVec3, including tool loading,
  dispatch, exact comparison, all-container build, scope and source-policy gates.
- Residual cold: actual psx_residual_objective for CopyVec3, source
  timing-candidate.c (fixed byte-for-byte copy of its matched source), json=true.
  Clear only build/residualObjective, pipelineReversal, targetSchedule, diff and
  contentCache. Ledger rows, sources, closures and evidence remain intact.
- Residual warm: the same complete provided-tool operation immediately after
  its cold residual call, with warm derived caches.
- Preparation: actual psx_m2c for CopyVec3, alternative=true; archive existing
  function preparation packets before each repetition rather than deleting them.

Each provided-tool row uses the same supported Pi 0.85.1 no-model SDK dispatch
helper, including resource loading and provenance checks, for both implementations.
These are complete operations, not internal compiler/CPU microbenchmarks.
Installation/public-source setup is outside the timed operation and recorded
separately; any dependency preparation required after emptying build stays inside
the timed cold operation. Every command/argv vector, timestamp, wall time and
output transcript is retained in the measurement records and scenario logs.
The final series was interrupted after executable-only repetition three; completed
rows were retained, and only its remaining operations resumed. No completed row
was replaced or selected away.

## Byte/verdict and flag-translation controls

Every successful full check compares all configured original containers, including
all cold repetitions. Complete finalization also passes its exact/build/scope/policy
gates. Profile refresh follows successful EXE comparison only; check-all skips
per-container verification rodata and performs one final all-container derivation.
Executable verification retains 120 seconds; finalization retains 300 seconds.
Scope/order/failure cases are covered by the focused verification regression gate.

Required negative controls, with affected artifacts forced to rebuild:

- Drop the overlay -G0 profile, rebuild ovl_11: original-byte MISMATCH, nonzero
  verdict. Restore the profile: byte-identical success.
- Drop func_80014494's effective -fno-cse-skip-blocks override and remove its
  object: verification fails with an original/built payload-truncation verdict,
  not an infrastructure success or stale-output pass. Restore it: complete
  all-container byte-identity succeeds.

The initial ovl_31 profile-drop pilot did not produce a material mismatch and was
not accepted as the negative control. The ovl_11 control above is the witnessed
failure. Raw control argv/verdicts and complete comparisons are preserved under
`build/installed-runtime/negative-controls/`.

## Performance repairs and retained evidence

Invocation-scoped SDK/dependency results, at-most-once EXE refresh/export,
content-validated build reuse, and direct verification/profile/rodata APIs remove
repeated orchestration work without accepting stale artifacts. The first harness
series exposed a residual startup regression. CPU profiles identified unnecessary
eager preparation/context-export imports; those modules now load only when the
corresponding operation needs them. Tool registrations and gate semantics remain.

The slower series is preserved unchanged in
`build/installed-runtime/timings/measurements.jsonl`; it is not acceptance data.
CPU profiles and pilot outputs remain under residual-profile. The authoritative
baseline rows are also in timings/measurements.jsonl; corrected harness rows and
complete logs are in timings-final/. Durable archive mappings are in each series'
`durable-archives.jsonl`. No binary inputs or generated artifacts belong in this
commit: only this timing table is committed for the plan's explicit acceptance gate.
