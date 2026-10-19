import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredTool, type ToolName } from "../lib/toolchain.js";
import { prepareM2c } from "../build/prepareM2c.js";
import { libraryMembers } from "../lib/libraryTargets.js";
import { libraryFunctionSource, libraryTuStatus, readLibraryTu } from "../lib/libraryTranslationUnit.js";
import { compileSource } from "./decompToolchain.js";
import { checkLibrary, prepareLibraryFunction, splitLibrary, writeLibraryGraph } from "./libraryTarget.js";
import { planLibraryTu } from "./librarySources.js";
import { foldLibraryTus, pendingFoldCleanups } from "./foldLibraryTu.js";
import { canonicalStub } from "../../.pi/extensions/psx-decomp/autoloop/park.js";
import { foldMatchedMember, runFoldCleanup } from "../../.pi/extensions/psx-decomp/autoloop/fold.js";
import { DOCUMENTATION_TOOLS, runLoop, type LoopDeps } from "../../.pi/extensions/psx-decomp/autoloop/loop.js";
import { DEFAULT_LOOP_CONFIG } from "../../.pi/extensions/psx-decomp/autoloop/config.js";
import { createTurnGate } from "../../.pi/extensions/psx-decomp/autoloop/turn-gate.js";

/** A member compiled from plain C, so its per-function C parts can match. */
function fixture(t: { after: (cleanup: () => void) => void; mock: { method: Function } }) {
  const root = mkdtempSync(join(tmpdir(), "psx-fold-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  config.compiler.source = { origin: "harness", path: config.compiler.source };
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.tools.m2c = prepareM2c(ROOT).script;
  config.includeDirs = ["include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.cc1 = config.flags.cc1.map((f: string) => f === "-G8" ? "-G0" : f);
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas" };
  mkdirSync(join(root, "include"));
  writeFileSync(join(root, "include/common.h"), "#ifndef COMMON_H\n#define COMMON_H\ntypedef int s32;\n#endif\n");
  for (const file of ["include_asm.h", "macro.inc", "gte_macros.inc"]) copyFileSync(join(ROOT, "include", file), join(root, "include", file));
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const first = "int first(int x) { return x + 1; }\n", second = "int second(int x) { return first(x) * 3; }\n";
  writeFileSync(join(root, "original.c"), first + second);
  writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["original.o"] },
    headers: { reference: [], owned: ["include"], context: ["common.h"] }, output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } }));
  return { root, config, first, second };
}
const quietly = <T>(t: { mock: { method: Function } }, task: () => T): T => {
  const log = t.mock.method(console, "log", () => {});
  try { return task(); } finally { log.mock.restore(); }
};

test("a finished C TU folds into one module that rebuilds the original; check, rollback, write and guards", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const seed = compileSource(join(f.root, "original.c"), join(f.root, "seed"), "original", { containerKind: "exe", assemble: false });
    execFileSync(f.config.tools.as, [...f.config.flags.as, seed.assembly, "-o", join(f.root, "original.o")]);
    quietly(t, () => splitLibrary());
    const member = libraryMembers()[0]!, directory = dirname(join(f.root, member.source));
    writeFileSync(join(directory, "first.c"), f.first); writeFileSync(join(directory, "second.c"), f.second);
    quietly(t, () => checkLibrary(["--member", member.id]));
    const snapshot = () => new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name), "utf8")]));
    const before = snapshot();

    const check = foldLibraryTus(false, [member.id]);
    assert.equal(check.members[0]!.verdict, "match"); assert.equal(check.members[0]!.module, "original.c");
    assert.deepEqual(snapshot(), before, "a check writes nothing under src");
    assert.throws(() => foldLibraryTus(true, [member.id], f.root, () => { throw new Error("forced mismatch"); }), /rolled back.*forced mismatch/);
    assert.deepEqual(snapshot(), before, "a failed write restores every part byte for byte");

    const written = quietly(t, () => foldLibraryTus(true, [member.id]));
    assert.equal(written.members[0]!.written, true);
    const manifest = readLibraryTu(member, f.root);
    assert.deepEqual(manifest.parts, [{ path: "original.c", symbols: ["first", "second"] }]);
    assert.deepEqual(readdirSync(directory).sort(), ["original.c", "tu.json"]);
    const moduleText = readFileSync(join(directory, "original.c"), "utf8");
    assert.equal(moduleText, [...before].filter(([name]) => name !== "tu.json").sort(([a], [b]) => manifestOrder(a) - manifestOrder(b)).map(([, text]) => text).join(""));
    assert.equal(libraryFunctionSource(member, "first"), member.source.replace("tu.json", "original.c"));
    assert.ok(libraryTuStatus(member, f.root)!.every(row => !row.stub));
    quietly(t, () => checkLibrary(["--member", member.id]));
    assert.ok(writeLibraryGraph().functions.every(fn => fn.decompiled), "folded functions stay decompiled");
    await assert.rejects(prepareLibraryFunction(`${member.id}::first`), /folded module/);
    assert.throws(() => canonicalStub(f.root, `${member.id}::first`), /folded module/);
    const split = planLibraryTu(member, moduleText);
    assert.deepEqual([...split.files.values()].join(""), moduleText, "splitting the module gives back its parts");
    const after = snapshot();
    quietly(t, () => splitLibrary());
    assert.deepEqual(snapshot(), after, "split leaves a folded module alone");
    assert.equal(foldLibraryTus(false, [member.id]).members[0]!.refused, "already folded");

    function manifestOrder(name: string): number { return ["_shared-0.h", "first.c", "second.c"].indexOf(name); }
  });
});

test("fold refuses a TU that still has extraction or a preserved attempt", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const seed = compileSource(join(f.root, "original.c"), join(f.root, "seed"), "original", { containerKind: "exe", assemble: false });
    execFileSync(f.config.tools.as, [...f.config.flags.as, seed.assembly, "-o", join(f.root, "original.o")]);
    quietly(t, () => splitLibrary());
    const member = libraryMembers()[0]!, directory = dirname(join(f.root, member.source));
    assert.match(foldLibraryTus(false, [member.id]).members[0]!.refused!, /still extraction/);
    writeFileSync(join(directory, "first.c"), f.first);
    writeFileSync(join(directory, "second.c"), f.second + "/* PARKED by /auto_decompilation_loop on today. */\n#if 0\nint old;\n#endif\n");
    assert.match(foldLibraryTus(false, [member.id]).members[0]!.refused!, /preserved attempt/);
    assert.ok(!existsSync(join(f.root, "build/libraries/fold-migration.json")));
  });
});

test("auto-fold after a match folds a ready member out of process and leaves an unready one alone", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const seed = compileSource(join(f.root, "original.c"), join(f.root, "seed"), "original", { containerKind: "exe", assemble: false });
    execFileSync(f.config.tools.as, [...f.config.flags.as, seed.assembly, "-o", join(f.root, "original.o")]);
    quietly(t, () => splitLibrary());
    const member = libraryMembers()[0]!, directory = dirname(join(f.root, member.source)), key = `${member.id}::second`;
    assert.deepEqual(await foldMatchedMember(f.root, key), { memberId: member.id, written: false }, "a member with extraction left is not ready");
    writeFileSync(join(directory, "first.c"), f.first); writeFileSync(join(directory, "second.c"), f.second);
    const folded = await foldMatchedMember(f.root, key);
    assert.equal(folded.written, true, JSON.stringify(folded)); assert.equal(folded.module, "original.c"); assert.equal(folded.directory, dirname(member.source));
    assert.deepEqual(readdirSync(directory).sort(), ["original.c", "tu.json"]);
    assert.deepEqual(await foldMatchedMember(f.root, key), { memberId: member.id, written: false }, "an already folded member is a no-op");
  });
});

test("fold cleanup keeps only module-only edits that pass the refinement gate, and records them", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const seed = compileSource(join(f.root, "original.c"), join(f.root, "seed"), "original", { containerKind: "exe", assemble: false });
    execFileSync(f.config.tools.as, [...f.config.flags.as, seed.assembly, "-o", join(f.root, "original.o")]);
    quietly(t, () => splitLibrary());
    const member = libraryMembers()[0]!, directory = dirname(join(f.root, member.source));
    writeFileSync(join(directory, "first.c"), f.first); writeFileSync(join(directory, "second.c"), f.second);
    quietly(t, () => foldLibraryTus(true, [member.id]));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { cwd: f.root });
    git("init", "--quiet"); git("add", "-A"); git("commit", "--quiet", "-m", "fixture");
    const modulePath = join(directory, "original.c"), fold = readFileSync(modulePath, "utf8"), manifest = readFileSync(join(f.root, member.source), "utf8");
    assert.deepEqual(pendingFoldCleanups(f.root).map(m => m.id), [member.id], "a fresh fold awaits its cleanup");
    const cleanup = (edit: () => void | string) => runFoldCleanup({ projectRoot: f.root, memberId: member.id, turn: async () => { const result = edit(); return typeof result === "string" ? result : true; } });
    const unchanged = () => { assert.equal(readFileSync(modulePath, "utf8"), fold); assert.equal(readFileSync(join(f.root, member.source), "utf8"), manifest); };

    let result = await cleanup(() => "the turn ended without a reply");
    assert.equal(result.status, "failed"); assert.match(result.error!, /without a reply/); unchanged();
    result = await cleanup(() => { writeFileSync(modulePath, fold + "/* tidy */\n"); writeFileSync(join(f.root, "include/common.h"), "/* drift */\n"); });
    assert.equal(result.status, "failed"); assert.match(result.error!, /edited outside the module.*include\/common\.h/); unchanged();
    assert.equal(readFileSync(join(f.root, "include/common.h"), "utf8"), "#ifndef COMMON_H\n#define COMMON_H\ntypedef int s32;\n#endif\n", "outside edits are restored");
    result = await cleanup(() => { writeFileSync(modulePath, fold.replace("x + 1", "x + 2")); });
    assert.equal(result.status, "failed"); assert.match(result.error!, /refinement gate failed/); unchanged();

    const cleaned = "/* original.o */\n#include \"common.h\"\n\n/* Successor of a value. */\n" + f.first + f.second;
    result = await cleanup(() => { writeFileSync(modulePath, cleaned); });
    assert.equal(result.status, "passed", result.error); assert.equal(result.changed, true);
    assert.equal(readFileSync(modulePath, "utf8"), cleaned);
    assert.match(readLibraryTu(member, f.root).parts[0]!.cleanedSha256!, /^[a-f0-9]{64}$/);
    assert.deepEqual(pendingFoldCleanups(f.root), [], "a passed cleanup is recorded");
  });
});

test("with autoFold the loop runs a pending fold cleanup as its own role before new targets, and commits it", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const seed = compileSource(join(f.root, "original.c"), join(f.root, "seed"), "original", { containerKind: "exe", assemble: false });
    execFileSync(f.config.tools.as, [...f.config.flags.as, seed.assembly, "-o", join(f.root, "original.o")]);
    quietly(t, () => splitLibrary());
    const member = libraryMembers()[0]!, directory = dirname(join(f.root, member.source));
    writeFileSync(join(directory, "first.c"), f.first); writeFileSync(join(directory, "second.c"), f.second);
    quietly(t, () => foldLibraryTus(true, [member.id]));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
    git("init", "--quiet"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "fixture");
    git("add", "-A"); git("commit", "--quiet", "-m", "fixture");
    const gate = createTurnGate(), sent: string[] = [], solverTools = ["read", "bash", "edit", "write", "psx_finalize_function"];
    const record = { tools: solverTools, toolsAtSend: [] as string[][], navigated: [] as string[] };
    const deps = {
      projectRoot: f.root, baseline: new Set<string>(), flag: { aborted: false },
      config: { ...DEFAULT_LOOP_CONFIG, runtimeDir: join(f.root, "run_output"), maxFunctions: 1, autoFold: true,
        ladder: [{ provider: "fixture", model: "cleanup-model", label: "cleanup-model", thinking: "off" }] },
      sink: { verdict: {}, handoff: {}, prep: {}, gate },
      pi: {
        getActiveTools: () => record.tools, setActiveTools: (value: string[]) => { record.tools = value; },
        getThinkingLevel: () => "off", setThinkingLevel: () => {}, setModel: async () => true,
        sendUserMessage: (message: string) => { sent.push(message); record.toolsAtSend.push([...record.tools]); gate.settled++; },
      },
      ctx: { model: { id: "cleanup-model" }, isIdle: () => true, waitForIdle: async () => {}, getContextUsage: () => undefined,
        navigateTree: async (id: string) => { record.navigated.push(id); },
        sessionManager: {
          getEntries: () => [{ type: "message", id: "solver-prompt", message: { role: "user" } }],
          getBranch: () => [{ type: "message", message: { role: "assistant", stopReason: "stop" } }],
        },
        ui: { notify: () => {}, setStatus: () => {}, setEditorText: () => {}, theme: { fg: (_color: string, text: string) => text } } },
    } as unknown as LoopDeps;
    await quietly(t, () => runLoop(deps));
    assert.match(sent[0]!, /^\/skill:psx-fold-cleanup Target: \S+ \(src\/libraries\/.*original\.c\)/);
    assert.deepEqual(record.toolsAtSend, [DOCUMENTATION_TOOLS], "cleanup runs with the documentation role's tools");
    assert.deepEqual(record.navigated, ["solver-prompt"], "on a cleared conversation");
    assert.deepEqual(record.tools, solverTools, "and the working tool set comes back");
    assert.deepEqual(pendingFoldCleanups(f.root), []);
    assert.equal(git("log", "-1", "--format=%s").trim(), `clean ${member.id}`);
  });
});
