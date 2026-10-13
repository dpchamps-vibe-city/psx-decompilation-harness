import { test, ROOT, fixtureContext } from "../../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { configuredTool, type ToolName } from "../../lib/toolchain.js";
import { libraryMembers, libraryTargetKey } from "../../lib/libraryTargets.js";
import { readRelocatableObject } from "../../lib/relocatableObject.js";
import { compileSource } from "../decompToolchain.js";
import { reconstructFunction } from "./engine.js";
import { decodeBytes, executeFunction, UnsupportedTarget } from "./exec.js";
import { recognizeBiosVeneer } from "./bios-veneer.js";
import { biosVeneerFindings } from "../triage.js";
import { withContextMode } from "./context-mode.js";
import { loadResult, readResultArtifact, resultDraft } from "./result-contract.js";

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "psx-library-reconstruction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.profiles = { library_test: { cc1: [...config.flags.cc1, "-fno-inline"] } };
  config.containerProfiles = {};
  config.includeDirs = ["include"];
  config.sdk.headers = { origin: "project", path: "include" };
  mkdirSync(join(root, "include"));
  writeFileSync(join(root, "include/common.h"), "");
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const select = (bytes: Buffer) => {
    writeFileSync(join(root, "original.o"), bytes);
    writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1,
      target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["original.o"] },
      headers: { reference: [], owned: ["include"], context: ["common.h"] }, toolchainProfile: "library_test" }));
    const member = libraryMembers(root)[0]!;
    return libraryTargetKey(member, member.functions[0]!.name);
  };
  const compile = (source: string) => {
    const path = join(root, "original.c"); writeFileSync(path, source);
    return readFileSync(compileSource(path, join(root, "compiled"), "original", {
      assemble: true, useOverrides: false, containerKind: "exe",
    }).object!);
  };
  const assemble = (source: string) => {
    writeFileSync(join(root, "original.s"), source);
    execFileSync(config.tools.as, ["-EL", "-march=r3000", "-G8", "-o", join(root, "assembled.o"), join(root, "original.s")]);
    return readFileSync(join(root, "assembled.o"));
  };
  return { root, select, compile, assemble };
}

test("BIOS fingerprint is structural, checks the delay slot, and never requests an assembly exception", () => {
  const bytes = Buffer.from("a0000a24080040013900092400000000", "hex");
  const insns = decodeBytes(bytes, 0);
  assert.deepEqual(recognizeBiosVeneer(insns), { vector: 0xa0, selector: 0x39, transferOffset: 4 });
  assert.throws(() => executeFunction(insns), (error: unknown) => error instanceof UnsupportedTarget && error.category === "bios-veneer");
  const findings = biosVeneerFindings(insns);
  assert.equal(findings[0]!.severity, "blocker");
  assert.ok(findings[0]!.evidence.some(line => line.includes("not a request to retain INCLUDE_ASM")));
  for (const changed of ["a0000a240800e0033900092400000000", "d0000a24080040013900092400000000",
    "a0000a24080040013900042400000000", "a0000a24080040010000000000000000"]) {
    assert.equal(recognizeBiosVeneer(decodeBytes(Buffer.from(changed, "hex"), 0)), undefined);
  }
});

test("SDK seven-word BIOS veneers require known constants and only their dead return epilogue", () => {
  const words = [0x01405024, 0x354a00b0, 0x01204824, 0x01400008, 0x35290018, 0x03e00008, 0];
  const decode = (values: number[]) => {
    const bytes = Buffer.alloc(values.length * 4); values.forEach((word, i) => bytes.writeUInt32LE(word, i * 4));
    return decodeBytes(bytes, 0);
  };
  assert.deepEqual(recognizeBiosVeneer(decode(words)), { vector: 0xb0, selector: 0x18, transferOffset: 12 });
  for (const [index, word] of [[0, 0], [2, 0], [4, 0x35240018], [5, 0x24020001], [6, 0x24040001], [4, 0x354a00c0]]) {
    const changed = [...words]; changed[index!] = word!;
    assert.equal(recognizeBiosVeneer(decode(changed)), undefined, `reject altered word ${index}`);
  }
  assert.equal(recognizeBiosVeneer(decode([...words, 0x24020001])), undefined, "no hidden neighbor operations");
});

test("library reconstruction resolves owner-qualified BIOS targets without any executable", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    const key = f.select(f.assemble(".set noreorder\n.text\n.globl InitHeap\n.type InitHeap,@function\nInitHeap:\naddiu $t2,$zero,0xa0\njr $t2\naddiu $t1,$zero,0x39\nnop\n.size InitHeap,.-InitHeap\n"));
    const result = reconstructFunction({ functionName: key, notify: () => {} });
    assert.equal(result.state, "unsupported-target", result.unresolved?.detail);
    assert.equal(result.unresolved!.category, "bios-veneer");
    assert.equal(result.vram, undefined);
    assert.equal(result.coordinate!.section, ".text");
    assert.deepEqual(result.unresolved!.coordinates, [{ section: ".text", offset: 4 }]);
    assert.equal(result.compiles, 0);
    assert.equal(result.build!.containerKind, "library");
    assert.ok(result.build!.cc1Flags.includes("-fno-inline"));
    assert.equal(existsSync(join(f.root, "src")), false, "no live source was authored");
    const loaded = loadResult(key); assert.ok(!("refused" in loaded));
    assert.ok(!("refused" in readResultArtifact(loaded, "target.json")));
    assert.ok("refused" in resultDraft(loaded));
  });
});

test("library reconstruction produces exact clean C only after whole-member verification", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    const key = f.select(f.compile("int f(void) { return 7; }\n"));
    const result = withContextMode("cold", () => reconstructFunction({ functionName: key, notify: () => {} }));
    assert.equal(result.state, "exact-candidate", JSON.stringify(result.candidates));
    assert.equal(result.winner!.memberVerification!.verdict, "match");
    assert.match(result.winner!.source, /f\(void\)/);
    assert.ok(!/INCLUDE_ASM|__asm__/.test(result.winner!.source));
    assert.equal(result.vram, undefined);
    assert.equal(result.verification!.scope, "translation-unit");
    assert.ok(result.inputsRead.every(path => !path.startsWith("src/")));
  });
});

test("a word-exact function cannot hide a differing ELF header or missing neighboring function", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    const bytes = f.compile("int f(void) { return 7; }\n");
    bytes.writeUInt32LE(bytes.readUInt32LE(36) ^ 1, 36);
    let key = f.select(bytes);
    let result = withContextMode("cold", () => reconstructFunction({ functionName: key, notify: () => {} }));
    assert.notEqual(result.state, "exact-candidate");
    assert.ok(result.candidates.some(c => c.matchedWords === c.totalWords && c.memberVerification!.verdict === "mismatch"));
    assert.equal(result.winner, undefined);
    // Compiling a fixture after selection is explicitly an EXE-profile compile;
    // it does not access a target image or treat library offsets as VRAM.
    key = f.select(f.compile("int f(void) { return 7; }\nint neighbor(void) { return 9; }\n"));
    result = withContextMode("cold", () => reconstructFunction({ functionName: key, notify: () => {} }));
    assert.notEqual(result.state, "exact-candidate");
    assert.equal(result.winner, undefined);
  });
});

test("symbolic storage relocations yield a scoped capability refusal, not invented absolute addresses", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    const key = f.select(f.compile("extern int cell; int f(void) { return cell; }\n"));
    const result = reconstructFunction({ functionName: key, notify: () => {} });
    assert.equal(result.state, "context-unresolved", result.unresolved?.detail);
    assert.equal(result.unresolved!.category, "symbolic-relocation");
    assert.ok(result.unresolved!.coordinates!.length);
    assert.equal(result.compiles, 0);
    assert.equal(result.vram, undefined);
    assert.ok(readRelocatableObject(readFileSync(join(f.root, "original.o"))).relocations.length);
  });
});

test("pointer storage and guarded argument trees reach the library candidate compiler", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    for (const source of ["void f(int *p) { p[0] = 3; }\n", "int f(int x) { if (x) return 7; return 9; }\n"]) {
      const key = f.select(f.compile(source));
      const result = withContextMode("cold", () => reconstructFunction({ functionName: key, notify: () => {} }));
      assert.ok(result.compiles > 0, result.unresolved?.detail);
      assert.ok(!["tool-failure", "context-unresolved"].includes(result.state), JSON.stringify(result.candidates));
    }
  });
});
