import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { projectFixture, FIXTURE_BASE, FIXTURE_OVERLAY_BASE } from "../testing/projectFixture.js";
import { loadMacroFunctions } from "./macroIdentity.js";
import { buildChainCensus, scanChainFunction, chainRow } from "./nestedFunctionScan.js";
import { assemble, type AsmLine } from "../agent/matching-reconstruction/fixture-asm.js";
const fn = (name: string, lines: AsmLine[], vram = 0x80010000, container = "exe") => {
  const words = assemble(lines.map(l => l[0] === "lwc2" ? ["lw", ...l.slice(1)] as AsmLine : l), vram);
  const bytes = Buffer.alloc(words.length * 4);
  let n = 0;
  for (const line of lines) if (line[0] !== "label") {
    const raw = words[n]!.raw;
    bytes.writeUInt32LE(line[0] === "lwc2" ? ((raw & 0x03ffffff) | (0x32 << 26)) >>> 0 : raw, n++ * 4);
  }
  return { name, container, vram, bytes };
};
const dead = fn("child", [["addiu", "sp", "sp", -8], ["sw", "v0", 0, "sp"], ["jr", "ra"], ["addiu", "sp", "sp", 8]], 0x80020000);

test("callee recipe needs exact non-read proof; save-forward needs the surviving saved-entry web", () => {
  assert.equal(scanChainFunction(dead).callee!.form, "dead-spill");
  assert.equal(scanChainFunction(fn("reload", [["sw", "v0", 0, "sp"], ["lw", "v1", 0, "sp"], ["jr", "ra"], ["nop"]])).callee!.form, "undetermined");
  assert.equal(scanChainFunction(fn("escape", [["sw", "v0", 0, "sp"], ["addu", "a0", "sp", "zero"], ["jr", "ra"], ["nop"]])).callee!.form, "undetermined");
  const saved: AsmLine[] = [["addu", "s0", "v0", "zero"], ["jal", 0x80030000], ["nop"], ["addu", "v0", "s0", "zero"], ["jal", dead.vram], ["nop"], ["jr", "ra"], ["nop"]];
  assert.equal(scanChainFunction(fn("saved", saved)).callee!.form, "save-forward");
  saved.splice(3, 0, ["addiu", "s0", "zero", 0]);
  assert.equal(scanChainFunction(fn("killed", saved)).callee!.form, "undetermined");
});

test("caller accepts all three placements, including long branch fallthrough; no fixed-window heuristic", () => {
  const delay = fn("delay", [["jal", dead.vram], ["addiu", "v0", "sp", 16], ["jr", "ra"], ["nop"]]);
  const before = fn("before", [["addiu", "v0", "sp", 16], ["jal", dead.vram], ["nop"], ["jr", "ra"], ["nop"]]);
  const branch = fn("branch", [["bne", "a0", "a1", "exit"], ["addiu", "v0", "sp", 16], ...Array.from({ length: 12 }, (): AsmLine => ["nop"]), ["jal", dead.vram], ["nop"], ["label", "exit"], ["jr", "ra"], ["nop"]]);
  const census = buildChainCensus([dead, delay, before, branch]);
  for (const name of ["delay", "before", "branch"]) assert.equal(chainRow(census, name)!.calls[0]!.verdict, "confirmed-pair");
  assert.deepEqual(census.rows.filter(r => r.function !== "child").map(r => r.calls[0]!.placement), ["call-delay", "before-call", "branch-delay"]);
  assert.equal(scanChainFunction(fn("zero", [["addu", "v0", "sp", "zero"], ["jal", dead.vram], ["nop"]])).calls[0]!.offset, 0);
});

test("ordinary &local staging and jalr $v0 are rejected by consumption, including the call delay slot", () => {
  for (const use of [["addu", "a0", "v0", "zero"], ["sw", "a0", 0, "v0"], ["lwc2", 9, 0, "v0"]] as AsmLine[]) {
    const result = scanChainFunction(fn("scratch", [["addiu", "v0", "sp", 16], ["jal", dead.vram], use]));
    assert.equal(result.calls[0]!.verdict, "rejected"); assert.match(result.calls[0]!.reason, /consumes|redefines/);
  }
  assert.equal(scanChainFunction(fn("indirect", [["addiu", "v0", "sp", 16], ["jalr", "v0"], ["nop"]])).calls[0]!.verdict, "rejected");
  assert.equal(scanChainFunction(fn("indirect-slot", [["jalr", "v0"], ["addiu", "v0", "sp", 16]])).calls[0]!.verdict, "rejected");
});

test("pairing is container-qualified; same-address overlay children cannot license each other", () => {
  const other = { ...dead, container: "ovl_b" };
  const caller = fn("parent", [["jal", dead.vram], ["addiu", "v0", "sp", 16]], 0x80010000, "ovl_a");
  assert.equal(chainRow(buildChainCensus([other, caller]), "parent")!.calls[0]!.verdict, "caller-candidate");
  assert.equal(chainRow(buildChainCensus([dead, caller]), "parent")!.calls[0]!.verdict, "confirmed-pair", "EXE call is separately resolvable");
});

test("fixture census settles forward families, ambiguous bodies and post-call false positives", (t) => {
  const entry = (name: string, offset: number, lines: AsmLine[], base = FIXTURE_BASE) =>
    ({ name, offset, words: assemble(lines, base + offset).map(w => w.raw) });
  const child = FIXTURE_BASE, forward = FIXTURE_BASE + 0x20;
  const spill: AsmLine[] = [["addiu", "sp", "sp", -8], ["sw", "v0", 0, "sp"], ["jr", "ra"], ["addiu", "sp", "sp", 8]];
  const saved: AsmLine[] = [
    ["addu", "s0", "v0", "zero"], ["jal", FIXTURE_BASE + 0x1000], ["nop"],
    ["beq", "a0", "zero", "one"], ["addu", "v0", "s0", "zero"],
    ["jal", child], ["nop"], ["j", "next"], ["nop"],
    ["label", "one"], ["jal", child], ["nop"],
    ["label", "next"], ["beq", "a1", "zero", "shared"], ["nop"],
    ["addu", "v0", "s0", "zero"], ["j", "shared_call"], ["nop"],
    ["label", "shared"], ["addu", "v0", "s0", "zero"],
    ["label", "shared_call"], ["jal", child], ["nop"], ["jr", "ra"], ["nop"],
  ];
  const fixture = projectFixture(t, { exe: [
    entry("chain_child", 0, spill), entry("chain_forward", 0x20, saved),
    entry("chain_parent", 0x80, [["jal", forward], ["addiu", "v0", "sp", 16], ["jal", forward], ["addiu", "v0", "sp", 0], ["jr", "ra"], ["nop"]]),
    entry("post_call_capture", 0xa0, [["jal", child], ["nop"], ["addu", "s0", "v0", "zero"], ["jr", "ra"], ["nop"]]),
    entry("live_chain", 0xc0, [["lw", "a0", 0, "v0"], ["jr", "ra"], ["nop"]]),
    entry("consumed_setup", 0xd0, [["addiu", "v0", "sp", 16], ["jal", child], ["addu", "a0", "v0", "zero"], ["jr", "ra"], ["nop"]]),
  ], overlays: {
    ovl_alpha: [entry("ovl_alpha_parent", 0, [["jal", forward], ["addiu", "v0", "sp", 12], ["jr", "ra"], ["nop"]], FIXTURE_OVERLAY_BASE)],
    ovl_beta: [entry("ovl_beta_uncalled", 0, spill, FIXTURE_OVERLAY_BASE)],
  } });
  const loaded = loadMacroFunctions(fixture.containers());
  assert.deepEqual(loaded.findings, []);
  const census = buildChainCensus(loaded.functions);
  assert.equal(census.complete, true);
  const savedRow = chainRow(census, "chain_forward")!;
  assert.equal(savedRow.callee!.form, "save-forward");
  assert.equal(new Set(savedRow.callee!.forwards.map(c => c.call)).size, 3, "distinct arms may share a physical call");
  assert.equal(savedRow.callee!.forwards.length, 4, "one setup can reach both branch destinations");
  assert.equal(chainRow(census, "chain_parent")!.calls.filter(c => c.verdict === "confirmed-pair").length, 2);
  assert.equal(chainRow(census, "ovl_alpha_parent")!.calls[0]!.verdict, "confirmed-pair", "overlay can call the EXE family");
  assert.equal(chainRow(census, "ovl_beta_uncalled")!.verdict, "callee-only");
  assert.equal(chainRow(census, "post_call_capture"), null, "post-call return is not entry-$2");
  const consumed = chainRow(census, "consumed_setup")!.calls[0]!;
  assert.equal(consumed.verdict, "rejected"); assert.match(consumed.reason, /call delay slot/);
  assert.equal(chainRow(census, "live_chain")!.verdict, "undetermined", "live dereference is not a dead-spill recipe");
});
