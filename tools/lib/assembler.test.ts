import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { HARNESS_ROOT, createRuntimeContext, inRuntimeContext } from "./runtimeContext.js";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { assemble, assembleAsync, assemblerInvocation, captureAssemblerExpansion, assemblerIdentity } from "./assembler.js";
import { configuredAssembler, configuredFlags, loadToolchain } from "./toolchain.js";
import { compilationIdentity } from "./cacheIdentity.js";
import { readRelocatableObject } from "./relocatableObject.js";

test("assembler schema rejects rewrites and unknown stages; profile replaces selection", t => {
  const f = projectFixture(t), put = (assembler: unknown) => f.put("toolchain.json", JSON.stringify({ ...f.toolchain, assembler, flags: { ...f.toolchain.flags, as: ["-EL", "-G0"] } }));
  for (const bad of [{ kind: "unknown" }, { kind: "gas", inputRewrites: [] }, { kind: "gas", postAssembly: ["unknown"] }, { kind: "gas", objectFormat: "unknown" }, { kind: "gas", postAssembly: ["psyq-dmpsx", "psyq-dmpsx"] }, { kind: "gas", objectFormat: "elf", postAssembly: ["psyq-lnk"] }, { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-lnk", "psyq-dmpsx"] }, { kind: "gas", lnkLayout: "early" }, { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-lnk"], lnkLayout: "other" }]) { put(bad); assert.throws(() => loadToolchain(f.root)); }
  put({ kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx"] });
  assert.deepEqual(configuredAssembler(undefined, f.root), { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx"] });
  f.put("toolchain.json", JSON.stringify({ ...loadToolchain(f.root), profiles: { native: { assembler: { kind: "maspsx" } } }, containerProfiles: { overlay: "native" } }));
  assert.deepEqual(configuredAssembler({ kind: "overlay" }, f.root), { kind: "maspsx", objectFormat: "elf", postAssembly: [] });
  f.toolchain.assembler = { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx", "psyq-lnk"] };
  f.toolchain.flags.as = ["-EL", "-G0", "-mips1"];
  f.toolchain.containerProfiles = {};
  f.toolchain.profiles = { early: { assembler: { ...f.toolchain.assembler, lnkLayout: "early" } } };
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  const standard = assemblerIdentity(undefined, f.root), early = assemblerIdentity({ kind: "library", profile: "early" }, f.root);
  assert.equal(standard.lnkLayout, "standard"); assert.equal(early.lnkLayout, "early");
  assert.notDeepEqual(standard, early);
  f.toolchain.profiles.early!.as = ["-EL", "-G8", "-mips1"];
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  assert.throws(() => loadToolchain(f.root), /requires explicit -G0/);
});

test("production GAS reads unchanged input; sync/async and listing agree, stages are opt-in", async t => {
  const f = projectFixture(t), input = join(f.root, "probe.s"), object = join(f.root, "probe.o");
  f.toolchain.flags.as = ["-EL", "-G0", "-mips1"];
  f.toolchain.assembler = { kind: "gas" }; f.put("toolchain.json", JSON.stringify(f.toolchain));
  const text = ".text\n.ent fixture\nfixture:\n move $2,$0\n .word 0x000000bf\n.end fixture\n.rdata\n.word 0x000000bf\n";
  f.put("probe.s", text);
  const invocation = assemblerInvocation(undefined, input, object, f.root);
  assert.equal(invocation.assemblerInput, input);
  assert.deepEqual(invocation.args, [...configuredFlags("as", undefined, f.root), input, "-o", object]);
  assemble(undefined, input, object, f.root);
  assert.equal(readFileSync(input, "utf8"), text); assert.equal(existsSync(`${object}.as-input.s`), false);
  assert.equal(readRelocatableObject(readFileSync(object)).sections.get(".text")!.data.readUInt32LE(4), 0xbf);
  const before = compilationIdentity(f.root);
  f.toolchain.assembler = { kind: "gas", postAssembly: ["psyq-dmpsx"] }; f.put("toolchain.json", JSON.stringify(f.toolchain));
  const receipt = await assembleAsync(undefined, input, object, f.root);
  assert.notDeepEqual(compilationIdentity(f.root), before);
  const parsed = readRelocatableObject(readFileSync(object));
  assert.equal(parsed.sections.get(".text")!.data.readUInt32LE(4), 0x4a280030);
  assert.equal(parsed.sections.get(".rodata")!.data.readUInt32LE(0), 0xbf);
  assert.equal(JSON.parse(readFileSync(`${object}.assembly.json`, "utf8")).stages[0].replacements.length, 1);
  const expansion = captureAssemblerExpansion(undefined, input, object, "fixture", f.root);
  assert.equal(JSON.parse(readFileSync(expansion.receipt, "utf8")).objectsIdentical, true);
  assert.ok(receipt.inputSha256);
});

test("declared stage identity binds its object readers and rejects missing implementation", t => {
  const f = projectFixture(t);
  f.toolchain.flags.as = ["-EL", "-G0", "-mips1"];
  f.toolchain.assembler = { kind: "gas", postAssembly: ["psyq-dmpsx"] };
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  const implementation = assemblerIdentity(undefined, f.root).stages[0]!.implementation;
  for (const file of implementation) f.put(`isolated-harness/${file.path}`, readFileSync(join(HARNESS_ROOT, file.path)));
  inRuntimeContext(createRuntimeContext(f.root, { harnessRoot: join(f.root, "isolated-harness") }), () => {
    const before = assemblerIdentity(undefined, f.root), identity = compilationIdentity(f.root);
    const reader = "tools/lib/objectFormats/ecoff.ts";
    f.put(`isolated-harness/${reader}`, readFileSync(join(HARNESS_ROOT, reader), "utf8") + "\n/* changed reader */\n");
    assert.equal(assemblerIdentity(undefined, f.root).stages[0]!.version, before.stages[0]!.version);
    assert.notEqual(assemblerIdentity(undefined, f.root).stages[0]!.sha256, before.stages[0]!.sha256);
    assert.notDeepEqual(compilationIdentity(f.root), identity);
    rmSync(join(f.root, "isolated-harness", reader));
    assert.throws(() => assemblerIdentity(undefined, f.root), /Missing psyq-dmpsx implementation/);
    f.toolchain.assembler = { kind: "gas" };
    f.put("toolchain.json", JSON.stringify(f.toolchain));
    assert.deepEqual(assemblerIdentity(undefined, f.root).stages, []);
  });
});

test("MASPSX identity includes implementation package, not only its launcher", t => {
  const f = projectFixture(t); f.put("shim/maspsx.py", "# launcher\n"); f.put("shim/maspsx/expansion.py", "# implementation one\n");
  f.toolchain.tools.maspsx = join(f.root, "shim/maspsx.py"); delete f.toolchain.assembler;
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  const a = assemblerIdentity(undefined, f.root), identity = compilationIdentity(f.root);
  f.put("shim/maspsx/expansion.py", "# implementation two\n");
  const b = assemblerIdentity(undefined, f.root);
  assert.equal((a as any).maspsx.sha256, (b as any).maspsx.sha256);
  assert.notEqual((a as any).maspsx.packageSha256, (b as any).maspsx.packageSha256);
  assert.notDeepEqual(compilationIdentity(f.root), identity);
});
