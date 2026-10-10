import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { projectFixture } from "../../testing/projectFixture.js";
import { resolveSignature, inferSignatureRange } from "./callee-signature.js";
import type { SymExpr } from "./types.js";

const fixture = projectFixture({ after });
fixture.put("src/fixture_scalar.c", "typedef int s32; s32 fixture_scalar(void) { return 0; }\n");
fixture.put("src/fixture_sink.c", "void fixture_sink(int a, int b) {}\n");
// Generated context is deliberately wrong: it must not become a witness.
fixture.put("include/functions.h", "void fixture_scalar(int, int, int);\n");
const [exe, overlay] = fixture.containers();

const ENTRY_A0: SymExpr = { kind: "entry", register: "a0" };
const ENTRY_A1: SymExpr = { kind: "entry", register: "a1" };
const ENTRY_A2: SymExpr = { kind: "entry", register: "a2" };
const ENTRY_A3: SymExpr = { kind: "entry", register: "a3" };
const CONST_42: SymExpr = { kind: "const", value: 42 };
const CONST_99: SymExpr = { kind: "const", value: 99 };
const makeArgSnapshot = (a0: SymExpr, a1: SymExpr, a2: SymExpr, a3: SymExpr): SymExpr[] => [a0, a1, a2, a3];

test("a defining source supplies real arity and return type, not the generated header", () => {
  const result = resolveSignature("fixture_scalar", undefined, exe!);
  assert.ok(!("unknown" in result), JSON.stringify(result));
  if ("unknown" in result) return;
  assert.equal(result.arity, 0);
  assert.equal(result.returnsValue, true);
  assert.equal(result.returnType, "s32");
  assert.equal(result.source, "matched");
});

test("an SDK callee resolves from the vendored prototype", () => {
  const result = resolveSignature("GetDispEnv", undefined, exe!);
  assert.ok(!("unknown" in result), JSON.stringify(result));
  if ("unknown" in result) return;
  assert.equal(result.source, "sdk");
  assert.equal(result.arity, 1);
  assert.ok(result.returnsValue);
});

test("an unresolved name returns unknown, never a guess", () => {
  assert.ok("unknown" in resolveSignature(null, undefined, exe!));
});

test("a missing defining source and absent target evidence return unknown", () => {
  assert.ok("unknown" in resolveSignature("definitely_not_a_function", 0x80000000, exe!));
});

test("an overlay resolves a defining source from its own project's executable", () => {
  const result = resolveSignature("fixture_sink", undefined, overlay!);
  assert.ok(!("unknown" in result), JSON.stringify(result));
  if ("unknown" in result) return;
  assert.equal(result.arity, 2);
  assert.equal(result.returnsValue, false);
  assert.equal(result.source, "matched");
});

test("inferSignatureRange: non-passthrough a0 gives arityHi=1 from caller side", () => {
  const args = makeArgSnapshot(CONST_42, ENTRY_A1, ENTRY_A2, ENTRY_A3);
  const result = inferSignatureRange(null, undefined, exe!, args, new Set(), 1);
  assert.equal(result.arityLo, 0);
  assert.equal(result.arityHi, 1);
  assert.equal(result.returns, "unknown");
});

test("inferSignatureRange: consumed call result yields returns=yes", () => {
  const args = makeArgSnapshot(CONST_42, CONST_99, ENTRY_A2, ENTRY_A3);
  const result = inferSignatureRange(null, undefined, exe!, args, new Set([1]), 1);
  assert.equal(result.returns, "yes");
  assert.equal(result.arityHi, 2);
});

test("inferSignatureRange: unconsumed call result yields returns=unknown", () => {
  const args = makeArgSnapshot(CONST_42, ENTRY_A1, ENTRY_A2, ENTRY_A3);
  assert.equal(inferSignatureRange(null, undefined, exe!, args, new Set(), 1).returns, "unknown");
});

test("inferSignatureRange: all entry args gives arityHi=0", () => {
  const args = makeArgSnapshot(ENTRY_A0, ENTRY_A1, ENTRY_A2, ENTRY_A3);
  const result = inferSignatureRange(null, undefined, exe!, args, new Set(), 1);
  assert.equal(result.arityLo, 0);
  assert.equal(result.arityHi, 0);
});

test("inferSignatureRange: non-passthrough a0,a1,a2 gives arityHi=3", () => {
  const args = makeArgSnapshot(CONST_42, CONST_99, { kind: "const", value: 7 }, ENTRY_A3);
  assert.equal(inferSignatureRange(null, undefined, exe!, args, new Set(), 1).arityHi, 3);
});
