import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { assemble, assembleAsync, assemblerInvocation, captureAssemblerExpansion, rewriteAssemblerInput } from "./assembler.js";
import { configuredAssembler, configuredFlags, configuredTool, loadToolchain } from "./toolchain.js";
import { compilationIdentity } from "./cacheIdentity.js";
import { readRelocatableObject } from "./relocatableObject.js";

const gas = { kind: "gas" as const, inputRewrites: ["move-addu"] };
test("assembler configuration validates closed selections and profile replacement", t => {
  const f = projectFixture(t), original = structuredClone(f.toolchain);
  const put = (config: unknown) => f.put("toolchain.json", JSON.stringify(config));
  for (const selection of [{ kind: "unknown" }, { kind: "gas" }, { kind: "maspsx", inputRewrites: [] }, { kind: "gas", inputRewrites: ["unknown"] }]) {
    put({ ...original, assembler: selection }); assert.throws(() => loadToolchain(f.root));
  }
  const config = { ...original, assembler: gas, flags: { ...original.flags, as: ["-EL", "-G0"] }, profiles: { native: { assembler: { kind: "maspsx" } }, empty: { assembler: { kind: "gas", inputRewrites: [] } } }, containerProfiles: { overlay: "native", exact: "empty" } };
  put(config);
  assert.deepEqual(configuredAssembler(undefined, f.root), gas);
  assert.deepEqual(configuredAssembler({ kind: "overlay" }, f.root), { kind: "maspsx", inputRewrites: [] });
  assert.deepEqual(configuredAssembler({ kind: "overlay", id: "exact" }, f.root), { kind: "gas", inputRewrites: [] });
  assert.equal(configuredAssembler({ kind: "overlay", id: "exact", profile: "native" }, f.root).kind, "maspsx");
  for (const as of [["-G8"], ["-G", "4"], ["--gpsize=8"], []]) { put({ ...config, flags: { ...config.flags, as } }); assert.throws(() => loadToolchain(f.root), /small-data/); }
});

test("single builder preserves legacy argv/identity and applies GAS rewrites only to instruction lines", t => {
  const f = projectFixture(t), input = join(f.root, "probe.s"), object = join(f.root, "probe.o");
  const text = "\tmove $2,$0 # period encoding\r\n# move $2,$0\nlabel: move $2,$0\n.include \"move.s\"\n.word move\nmove: nop\nmove $32,$0\n#APP\nmove $2,$0\n#NO_APP\n";
  f.put("probe.s", text);
  const legacy = assemblerInvocation(undefined, input, object, f.root);
  assert.deepEqual(legacy, { command: configuredTool("python", f.root), args: [configuredTool("maspsx", f.root), ...configuredFlags("maspsx", undefined, f.root), "--gnu-as-path", configuredTool("as", f.root), "-o", object, ...configuredFlags("as", undefined, f.root), input], cwd: f.root, assemblerInput: input });
  const before = compilationIdentity(f.root);
  assert.equal("assembler" in before, false, "legacy v1 key is unchanged");
  f.put("toolchain.json", JSON.stringify({ ...f.toolchain, assembler: gas, flags: { ...f.toolchain.flags, as: ["-EL", "-G0"] } }));
  const invocation = assemblerInvocation(undefined, input, object, f.root), rewritten = readFileSync(invocation.assemblerInput, "utf8");
  assert.equal(rewritten, text.replace("\tmove $2,$0", "\taddu $2,$0,$0"));
  assert.equal(rewritten.split("\n").length, text.split("\n").length);
  assert.equal(rewriteAssemblerInput(text, []), text);
  assert.deepEqual(invocation.args, [...configuredFlags("as", undefined, f.root), object + ".as-input.s", "-o", object]);
  assert.equal(invocation.cwd, f.root);
  assert.notDeepEqual(compilationIdentity(f.root), before);
  assert.equal("maspsx" in (compilationIdentity(f.root).tools as object), false);
  assert.equal(assemblerInvocation(undefined, input, object, f.root, { handwritten: true }).assemblerInput, input);
});

test("synthetic backend words, default GAS swap and byte-identical listing receipts", async t => {
  const f = projectFixture(t), config = structuredClone(f.toolchain);
  config.flags.as = ["-march=r3000", "-mtune=r3000", "-EL", "-G0"];
  const cases = [
    { body: "lw $2,sym($4)", gas: [0x3c020000, 0x00441021, 0x8c420000], maspsx: [0x3c010000, 0x00240821, 0x8c220000] },
    { body: "lw $4,sym($4)", gas: [0x3c010000, 0x00240821, 0x8c240000], maspsx: [0x3c010000, 0x00240821, 0x8c240000] },
    { body: "move $2,$0", gas: [0x00001021], maspsx: [0x00001021] },
    { body: "sw $4,sym\n j $31", gas: [0x3c010000, 0x03e00008, 0xac240000], maspsx: [0x3c010000, 0xac240000, 0x03e00008, 0] },
  ];
  for (const kind of ["maspsx", "gas"] as const) {
    f.put("toolchain.json", JSON.stringify({ ...config, assembler: kind === "gas" ? gas : { kind } }));
    for (const [i, probe] of cases.entries()) {
      const input = join(f.root, `${kind}-${i}.s`), object = join(f.root, `${kind}-${i}.o`);
      f.put(`${kind}-${i}.s`, `.text\n\t.ent\tfixture\nfixture:\n ${probe.body}\n\t.end\tfixture\n`);
      const receipt = kind === "gas" ? await assembleAsync(undefined, input, object, f.root) : assemble(undefined, input, object, f.root);
      if (kind === "gas") assert.equal(receipt.stderr, "");
      const data = readRelocatableObject(readFileSync(object)).sections.get(".text")!.data;
      assert.deepEqual(probe[kind], probe[kind].map((_, n) => data.readUInt32LE(n * 4)));
      const expansion = captureAssemblerExpansion(undefined, input, object, "fixture", f.root);
      const record = JSON.parse(readFileSync(expansion.receipt, "utf8"));
      assert.equal(record.kind, kind); assert.ok(record.objectSha256 && record.inputSha256);
      if (kind === "gas") { assert.ok(expansion.listing); assert.equal(record.objectsIdentical, true); assert.equal(record.listingObjectSha256, record.objectSha256); }
    }
  }
  f.put("toolchain.json", JSON.stringify({ ...config, assembler: gas, flags: { ...config.flags, as: [...config.flags.as, "-O1"] } }));
  f.put("swap.s", ".text\n\t.ent\tfixture\nfixture:\n sw $4,sym\n j $31\n\t.end\tfixture\n");
  assemble(undefined, join(f.root, "swap.s"), join(f.root, "swap.o"), f.root);
  const data = readRelocatableObject(readFileSync(join(f.root, "swap.o"))).sections.get(".text")!.data;
  assert.deepEqual([0, 4, 8, 12].map(n => data.readUInt32LE(n)), cases[3]!.maspsx);
});
