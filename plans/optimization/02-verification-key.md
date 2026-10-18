# Phase 2 — Verification key and record writes

Status: proposed. Depends on: Phase 0, decision D5.

## Goal

A harness edit should cause mass re-verification only when it can change what
verification computes. When re-verification is needed, it should be parallel
and incremental.

Target: no 7–20 s finalize outliers from edits outside the verification path.
A real re-verification of ~790 members takes a few seconds, not 6–16 s.

## Where the time goes today

`libraryVerificationKey` (`tools/agent/libraryTarget.ts:367`) hashes:

- every non-test file under the harness `tools/` tree, except `vendor/`,
  `node_modules/` and `__pycache__/`. That includes `tools/testing/`,
  `tools/diagnostics/` and other unrelated tools;
- `tools/vendor/tree-sitter-c`;
- `.pi/extensions/shared`;
- `package-lock.json`.

`recordedMatch` (`:380`) requires the key to be equal. After any harness edit,
the next `check --member` therefore recompiles every accepted member: 760–789
compiles, one after another, at 8–20 ms each.

Records are written only after the whole batch passes `assertUnchanged`
(`:354-355`). One throwing member throws away every re-verification already
done in that batch.

## Work items

### 2.1 Key on the verification closure

Replace the `tools/` sweep with the verification path's module closure:

- the static import graph from the check, compile, compare and policy entry
  points, computed with the TypeScript compiler API, which is already a
  dependency;
- the dynamic imports that path uses, listed explicitly next to the entry
  points;
- the runtime data files it reads: the tree-sitter grammar wasm and its
  `pin.json`, `package-lock.json` for dependency versions, and anything else
  found by 2.2.

Keep `sourcePolicy` in the key. Compute the closure once per process and
memoize it.

### 2.2 Closure-completeness test

A test runs a member check on the synthetic fixture, with a loader hook (or
`--experimental-loader` / module registration) that records every module URL
loaded. It asserts that each loaded harness module is in the closure. A
module the closure misses fails the test, with its path. File reads under the
harness root during the check are recorded the same way, so data files can't
be missed silently.

### 2.3 Per-member record writes

After each member passes, re-check that member's identity and write its record
atomically (write-temp-then-rename). A throw on one member no longer discards
the others. The batch-level `assertUnchanged` still decides whether the batch
as a whole passed, and any member whose identity changed during the batch is
left unrecorded.

### 2.4 Parallel re-verification

When more than one member needs re-verification, compile them concurrently with
`compileSourceAsync`, with concurrency bounded by CPU count. Compare and write
each record as its compile finishes.

## Measurement and acceptance

Scenarios: harness edit outside the closure, harness edit inside the closure,
header touch affecting K members, toolchain change.

- An edit outside the closure (for example `tools/testing/*.ts` or
  `tools/diagnostics/*.ts`) means the next finalize reuses every record. The
  "N−1 unchanged" line comes back, and there is no outlier.
- An edit inside the closure, or a dependency or `sourcePolicy` change, still
  re-verifies every affected member. This is the negative control.
- A full re-verification of ~790 members finishes in at most
  (serial time ÷ cores) + overhead on the bench, with records equal to a
  serial run's.
- If one member is made to throw mid-batch, every other member's record is
  still written, and the batch still fails.

## Must not change

- Accepted-record contents and schema, apart from the key value.
- The meaning of the key: "the harness that compiled, compared and audited the
  member, and the policy it was audited under".
- The explicit `check --accepted` and unscoped checks still recompile every
  member they select.

## Risks

- **A module or data file outside the closure that changes verification
  output.** Mitigation: the 2.2 completeness test runs in `npm test`, and a
  conservative fallback adds any module whose classification is uncertain.
- **Parallel compiles changing output.** Compiles are pure functions of their
  inputs. The equivalence oracle compares parallel records with serial ones.
