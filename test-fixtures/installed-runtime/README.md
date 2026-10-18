# Instruction contracts

`instruction-baseline.json` and the exact I1/I2 ledger in
`plans/installed-package-runtime-instruction-edits.json` are historical evidence
for the installed-runtime migration. Keep them intact; later authorized policy,
SDK-macro and diagnostic changes are not migration regressions.

The live byte-preservation gate uses `instruction-current.json`. Its generator
covers `AGENTS.md`, active matching prompts, skill files, reference sheets and
all registered description spans discovered under `.pi/extensions/`. It checks
both exact SHA-256 fingerprints and file inventory. Implementation-only edits
around tool descriptions do not alter their fingerprints. Installed consumers
check the same package resources, excluding the project-only agent guide.

After reviewing an intentional instruction change, run:

```sh
npm run test:update-instructions
```

Review and include the resulting fingerprint diff with that change. Tests never
regenerate or accept a snapshot automatically. Do not hand-edit generated JSON.
The reference/parameter checks and negative drift controls run independently of
the fingerprint gate.
