# Flag hypothesis — probe early, apply on evidence

Per-file flag overrides are per-TU facts of the original build, not hacks.
They are permitted when the evidence bar below is met, and forbidden as
speculative flag-shopping when it is not.

Loaded on demand by `psx_reference`. Read the sheet for the pass the
pipeline reversal named, and only that one.

---

## 11. Flag hypothesis: probe early, apply on evidence

Per-file flag overrides are a legitimate, evidence-gated matching tool.
Original TUs really were compiled with per-file flags, and an override can
be the TU's true state rather than a workaround; a proven flag is a per-TU
fact — record it in the file-groupings ledger and expect it on the group's
other members. Some fingerprint classes are unreachable under baseline
flags outright (example: an adjacent symbolic lui/lw self-clobber pair with
an unfillable load-delay nop is the unsplit assembler-macro load; under
split addresses the lui is an independent insn that the post-reload
scheduler lifts whenever its destination register has no intervening
hazard, so no source shape or allocation pins it).

When a target carries a structural fingerprint that is hard or impossible to
reach from natural C under the baseline flags, run `psx_flag_probe` EARLY —
before deep source archaeology — and read its three evidence sources: target
fingerprints (decoded from original bytes, no source needed), a flag-matrix
score of the current source, and nearby overrides (flags are per-TU, so
neighbors share them). The evidence bar: a fingerprint, plus a flag column
that dominates baseline, plus no contrary witness in the same region. When
the bar is met, propose a human-reviewed change to `toolchain.json.fileFlags`,
record its evidence in project metadata, and add the matching `flag-override`
allowlist entry in `.pi/autoloop.json` in the same change. The allowlist is the
audit trail the policy gate enforces; workers may not edit the toolchain or
grant themselves an exception. Do not add an override without a fingerprint,
and never switch off an optimization the target shows signs of using. A probe
that shows baseline equal to the flag delta kills that flag hypothesis; measure
a different source shape rather than treating historical examples as target
evidence.

### Equivalent guarded stores can expose CSE skipping

A target with sign-exclusive `lw/add/sw` arms on the **same effective address**
(`move`-copied bases), a jump after the positive store, and two separate stores
may lose an arm under baseline `-fcse-skip-blocks`. Classify that as a
population/CFG residual first; an independently written second `if` may retain
two stores but still lose the target jump. Probe `-fno-cse-skip-blocks`, then
check pointer provenance: a candidate `addiu %lo(symbol)` where the target
has `move copied_base` is a different source-web defect, not a flag verdict.
Require the usual fingerprint/column/regional evidence and a relocated-byte
match before adopting the override. See
`notes/retros/2026-10-03-ovl_11_func_80103B24-retro.md`.

