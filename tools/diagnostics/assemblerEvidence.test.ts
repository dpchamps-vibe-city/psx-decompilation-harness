import assert from "node:assert/strict";
import { test } from "node:test";
import { indexedLoadCensus, lnkPackaging } from "./assemblerEvidence.js";
import { inverseAssembler } from "../agent/pipeline-reversal/inverse-assembler.js";
import { liftWords } from "../agent/pipeline-reversal/lift.js";
import { fingerprintSelfClobberLoads, fingerprintsOf } from "../agent/flagProbe.js";
import { symbolicSelfClobberPairs } from "../agent/triage.js";
import { parseEmissionAttribution } from "../agent/compiler-trace/emission-attribution.js";
import type { RelocatableObject } from "../lib/relocatableObject.js";
import type { RenderedWord } from "../lib/functionOracle.js";

function triple(temp: "at" | "v0", base = "a0") {
  const r = temp === "at" ? 1 : 2, b = base === "v0" ? 2 : 4;
  const raw = [(15 << 26) | (r << 16), (r << 21) | (b << 16) | (r << 11) | 33, (35 << 26) | (r << 21) | (2 << 16)];
  const text = [`lui ${temp},%hi(slot)`, `addu ${temp},${temp},${base}`, `lw v0,%lo(slot)(${temp})`];
  const words = raw.map((word, i) => ({ vram: i * 4, raw: word >>> 0, text: text[i], coordinate: { kind: "section", section: ".text", offset: i * 4 },
    ...([0, 2].includes(i) ? { relocations: [{ reference: "import:slot" }] } : {}) })) as RenderedWord[];
  const data = Buffer.alloc(12); raw.forEach((w, i) => data.writeUInt32LE(w >>> 0, i * 4));
  const object = { sections: new Map([[".text", { flags: 4, data }]]), relocations: [
    { section: ".text", offset: 0, type: 5, reference: "import:slot" }, { section: ".text", offset: 8, type: 6, reference: "import:slot" },
  ] } as unknown as RelocatableObject;
  return { raw, text, words, object };
}
test("indexed inverse, fingerprints and census use the effective assembler rules", () => {
  const at = triple("at"), dest = triple("v0");
  for (const [probe, kind, count] of [[at, "maspsx", 1], [at, "gas", 1], [dest, "gas", 1], [dest, "maspsx", 3]] as const) {
    const result = inverseAssembler(liftWords({ functionName: "fixture", words: probe.words }), kind);
    assert.equal(result.program.insns.length, count);
    if (count === 1) { assert.deepEqual(result.program.insns[0]!.uses, ["a0"]); assert.ok(result.merged[0]!.rule); }
  }
  assert.equal(inverseAssembler(liftWords({ functionName: "fixture", words: triple("v0", "v0").words }), "gas").merged.length, 0);
  assert.equal(indexedLoadCensus(dest.object).classification, "gas-rule");
  assert.equal(indexedLoadCensus(at.object).classification, "aspsx-rule");
  assert.equal(indexedLoadCensus(triple("at", "v0").object).counts.ambiguous, 1);
  assert.equal(symbolicSelfClobberPairs(dest.text, "gas").length, 1);
  assert.equal(symbolicSelfClobberPairs(dest.text, "maspsx").length, 0);
  assert.equal(fingerprintSelfClobberLoads(dest.raw, "gas").length, 1);
  assert.deepEqual(fingerprintsOf([0x3c050000, 0x8ca50000])[0]!.candidates, []);
  assert.match(parseEmissionAttribution("", "gas").caveats.join(" "), /listing\/object/);
});
test("native packaging signature is bounded and reports incomplete records honestly", () => {
  const string = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
  const section = (id: number, name: string) => Buffer.concat([Buffer.from([16, id & 255, id >>> 8, 0, 0, 4]), string(name)]);
  const converter = Buffer.concat([Buffer.from("4c4e4b02", "hex"), section(0xf004, ".rdata"), section(0xf000, ".text"), Buffer.from([0])]);
  const native = Buffer.concat([Buffer.from("4c4e4b02", "hex"), section(1, ".text"), section(2, ".ctors"), Buffer.from([28, 1, 0]), string("fixture.c"), Buffer.from([0])]);
  assert.equal(lnkPackaging(converter).classification, "gnu-converter-style");
  assert.equal(lnkPackaging(native).classification, "aspsx-native-style");
  assert.equal(lnkPackaging(native).fileRecords, 1);
  assert.equal(lnkPackaging(native.subarray(0, -2)).classification, "undetermined");
  assert.equal(lnkPackaging(Buffer.concat([converter.subarray(0, -1), Buffer.from([255])])).complete, false);
});
