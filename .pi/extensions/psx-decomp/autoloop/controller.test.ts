import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixtureContext } from "../../../../tools/testing/runtimeTestContext.js";
import { seedProjectFixture } from "../../../../tools/testing/projectFixture.js";
import { installedCommandFixture } from "../../../../tools/testing/commandFixture.js";
import { configuredToolchainIdentity } from "../../../../tools/agent/decompToolchain.js";
import { configuredCompilerAnalysis } from "../../../../tools/lib/toolchain.js";
import { DEFAULT_LOOP_CONFIG } from "./config.js";
import { runLoopWithSubagents, type ControllerSink } from "./controller.js";
import { createTurnGate } from "./turn-gate.js";
import type { LoopDeps } from "./loop.js";

for (const [takeover, commitOnMatch, refuseCommit, failIntegration, failTurn] of [
  [false, false, false], [true, false, false], [true, true, false], [true, true, true],
  [true, false, false, true], [false, false, false, false, true],
]) test(failTurn ? "an exception after ordinary worker promotion restores live source and retains the draft"
  : failIntegration ? "a failed immediate integration restores source while sibling work is still running"
  : refuseCommit
  ? "a refused immediate integration commit stops the loop before another function can absorb the match"
  : commitOnMatch ? "integration commits immediately while the primary worker is still running, exactly once per function"
  : takeover ? "main takes over a partial build candidate and integrates it while a sibling worker is still running"
  : "one existing main-loop turn delegates N functions, then the same loop verifies and closes both without worker loops", async t => {
  const root = mkdtempSync(join(tmpdir(), "psx-main-loop-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedProjectFixture(root);
  for (const dir of ["src", "include", "configs", ".pi", "build", "run_output"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "build/\nrun_output/\n");
  writeFileSync(join(root, "include/.keep"), "");
  writeFileSync(join(root, ".pi/autoloop.json"), JSON.stringify({ autoFold: true, commitOnMatch, commitOnPark: false }));
  const names = ["first", "second"];
  for (const name of names) writeFileSync(join(root, `src/${name}.c`), `INCLUDE_ASM("build/asm", ${name});\n`);
  writeFileSync(join(root, "build/callGraph.json"), JSON.stringify({ functions: names.map((name, i) => ({
    name, source: `src/${name}.c`, vram: `0x80010${i}00`, container: "exe", decompiled: false, handwritten: false, dead: false,
  })) }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet"); git("add", ".");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  git("commit", "--quiet", "-m", "fixture");
  if (refuseCommit) {
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  await fixtureContext(root, async () => {
    const packet = {
      schemaVersion: 1, identity: { functionName: "", container: "exe", destination: "", assembly: "build/original.s", data: [], inputs: {}, flags: [], tools: configuredToolchainIdentity() },
      primary: { origin: "existing-attempt", path: "", text: "", sha256: "", declarationsRequired: [] },
      context: { projection: "build/context.c", unknown: [], headers: [] }, generation: { status: "generated" },
      compilation: { status: "succeeded", diagnostics: "", commands: [] }, comparison: { status: "mismatch" },
      integration: { state: "live", blockers: [], destinationHash: "" }, discovery: { compilerAnalysis: configuredCompilerAnalysis(root), unknowns: [], priorExperiments: [], preflight: [] }, finalization: { status: "not-attempted" },
    };
    installedCommandFixture(t, root, {
      "tools/agent/callGraph.ts": `import {readFileSync,writeFileSync} from 'node:fs'; const path='build/callGraph.json', graph=JSON.parse(readFileSync(path,'utf8')); for(const fn of graph.functions) fn.decompiled=!readFileSync(fn.source,'utf8').includes('INCLUDE_ASM'); writeFileSync(path,JSON.stringify(graph));`,
      "tools/build/pipeline.ts": "import {existsSync} from 'node:fs'; if (process.argv.some(arg => arg === 'split' || arg === 'split-all')) throw new Error('Workers must not split or create a second project'); if(existsSync('build/fail-integration')) process.exit(1); /* Synthetic build oracle. */",
      "tools/agent/diffFunc.ts": 'console.log("Match: 2/2 words (100%)\\nVERDICT: MATCH");',
      "tools/agent/contextExport.ts": 'console.log(\'CONTEXT_EXPORT_STATUS {"status":"published","signatureMatches":true}\');',
      "tools/agent/m2cFunc.ts": `
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const packet=${JSON.stringify(packet)}, name=process.argv[2], path='src/'+name+'.c', text=readFileSync(path,'utf8');
packet.identity.functionName=name;packet.identity.destination=path;packet.primary.path=path;packet.primary.text=text;
packet.primary.sha256=createHash('sha256').update(text).digest('hex');
packet.comparison.status=text.includes('INCLUDE_ASM')?'mismatch':'exact';
writeFileSync('build/packet.json',JSON.stringify(packet));console.log(JSON.stringify({path:'build/packet.json'}));`,
    });
    const events = new EventEmitter(), requests: any[] = [], messages: string[] = [], gate = createTurnGate();
    const controller: ControllerSink = {};
    let controlFailure: unknown;
    events.on("subagents:rpc:v1:request", request => events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: {} }));
    events.on("pi-subagents:runtime-agent-register:v1", request => { request.result = { ok: true, registration: { dispose() {} } }; });
    events.on("prompt-template:subagent:request", request => {
      requests.push(request);
      const name = request.task.match(/Assigned function: (\w+)\./)![1];
      assert.match(request.task, /Do not start an autoloop/);
      const candidate = request.task.match(/Write and test your candidate ONLY at (.+?);/)![1];
      assert.match(readFileSync(join(root, `src/${name}.c`), "utf8"), /INCLUDE_ASM/, "workers must leave main source untouched");
      writeFileSync(candidate, `int ${name}(void) { return ${takeover && name === "second" ? "0; /* unfinished */" : "1;"} }\n`);
      if (!takeover) queueMicrotask(() => events.emit("prompt-template:subagent:response", { ...request, status: "completed" }));
    });
    events.on("prompt-template:subagent:cancel", request => events.emit("prompt-template:subagent:response", { ...request, status: "cancelled" }));
    let tools = ["read", "edit", "write", "bash"];
    const deps = {
      projectRoot: root, baseline: new Set<string>(), flag: { aborted: false }, sink: { verdict: {}, handoff: {}, prep: {}, gate },
      config: { ...DEFAULT_LOOP_CONFIG, runtimeDir: join(root, "run_output"), maxFunctions: 2, autoFold: true,
        updateFileGroupings: false, commitOnMatch, commitOnPark: false,
        ladder: [{ provider: "fixture", model: "controller", label: "controller", thinking: "off" }],
        subagents: { quantity: 2, model: { provider: "fixture", model: "worker", label: "worker", thinking: "off" } } },
      pi: { events: { emit: (name: string, data: unknown) => events.emit(name, data), on: (name: string, handler: (...args: any[]) => void) => {
        events.on(name, handler); return () => events.off(name, handler);
      } }, getActiveTools: () => tools, setActiveTools: (value: string[]) => { tools = value; },
        getThinkingLevel: () => "off", setThinkingLevel() {}, setModel: async () => true,
        sendUserMessage: (message: string) => {
          messages.push(message);
          if (!takeover) { gate.settled++; return; }
          void (async () => {
            const batch = controller.batch!;
            const handoff = await batch.control("takeover", 1) as any;
            assert.equal(handoff.takenOver, true);
            assert.match(readFileSync(join(root, "src/second.c"), "utf8"), /INCLUDE_ASM/, "partial takeover does not promote main source");
            assert.match(readFileSync(handoff.candidate, "utf8"), /unfinished/);
            writeFileSync(handoff.candidate, "int second(void) { return 1; }\n");
            if (failIntegration) writeFileSync(join(root, "build/fail-integration"), "fail\n");
            const integrated = await batch.control("integrate", 1) as any;
            if (failIntegration) {
              assert.equal(integrated.integrated, false, integrated.feedback);
              assert.match(integrated.feedback, /promotion rolled back/);
              assert.match(readFileSync(join(root, "src/second.c"), "utf8"), /INCLUDE_ASM/);
              assert.match(readFileSync(handoff.candidate, "utf8"), /return 1/);
              assert.equal(batch.jobs[0]!.handle.result, undefined);
              deps.flag.aborted = true; gate.settled++; return;
            }
            assert.equal(integrated.integrated, true, integrated.feedback);
            assert.match(readFileSync(join(root, "src/second.c"), "utf8"), /return 1/);
            assert.equal(batch.jobs[0]!.handle.result, undefined, "sibling work continues throughout takeover and full main verification");
            const persisted = JSON.parse(readFileSync(join(root, "run_output/state.json"), "utf8"));
            assert.equal(persisted.completions.second.verification, "passed");
            if (refuseCommit) {
              assert.match(integrated.feedback, /Loop stopped.*not committed/);
              assert.equal(deps.flag.aborted, true);
              assert.equal(integrated.commit, undefined);
              assert.equal(persisted.completions.second.commit, undefined);
              assert.equal(git("log", "-1", "--format=%s").toString().trim(), "fixture");
              gate.settled++;
              return;
            }
            if (commitOnMatch) {
              assert.equal(git("log", "-1", "--format=%s").toString().trim(), "match second", "commit must precede the unrelated primary's completion");
              assert.match(integrated.commit, /^[0-9a-f]+$/);
              assert.equal(persisted.completions.second.commit, integrated.commit);
              assert.deepEqual(git("show", "--format=", "--name-only", "HEAD").toString().trim().split("\n"), ["src/second.c"]);
            } else {
              assert.equal(git("rev-list", "--count", "HEAD").toString().trim(), "1");
              assert.equal(integrated.commit, undefined);
            }
            events.emit("prompt-template:subagent:response", { ...requests[0], status: "completed" });
            gate.settled++;
          })().catch(error => { controlFailure = error; deps.flag.aborted = true; });
        } }, 
      ctx: { model: { provider: "fixture", id: "controller" }, modelRegistry: { find: () => ({ provider: "fixture", id: "controller" }) },
        isIdle: () => true, waitForIdle: async () => {}, getContextUsage: () => undefined,
        sessionManager: { getEntries: () => [], getBranch: () => [] },
        ui: { notify() {}, setStatus(_key: string, value?: string) {
          if (failTurn && value?.includes("· oracle") && !readFileSync(join(root, "src/first.c"), "utf8").includes("INCLUDE_ASM"))
            throw new Error("synthetic post-promotion graph failure");
        }, setEditorText() {}, theme: { fg: (_color: string, text: string) => text } } },
    } as unknown as LoopDeps;
    if (failTurn) {
      await assert.rejects(runLoopWithSubagents(deps, {}, controller), /synthetic post-promotion graph failure/);
      assert.match(readFileSync(join(root, "src/first.c"), "utf8"), /INCLUDE_ASM/);
      const candidate = requests[0].task.match(/Write and test your candidate ONLY at (.+?);/)![1];
      assert.match(readFileSync(candidate, "utf8"), /return 1/);
      assert.equal(controller.unsafe, undefined);
      return;
    }
    const outcomes = await runLoopWithSubagents(deps, {}, controller);
    assert.ifError(controlFailure);
    assert.deepEqual(outcomes.map(outcome => [outcome.functionName, outcome.kind]), refuseCommit || failIntegration
      ? [["first", "aborted"]] : [["first", "matched"], ["second", "matched"]]);
    assert.deepEqual(git("log", "--format=%s").toString().trim().split("\n"), commitOnMatch && !refuseCommit
      ? ["match first", "match second", "fixture"] : ["fixture"]);
    if (commitOnMatch && !refuseCommit) assert.ok(outcomes.every(outcome => outcome.kind === "matched" && outcome.commit));
    assert.equal(messages.length, 1, "one controller work turn, not one independent loop per worker");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.cwd === root), "all workers use the existing project, not worktrees");
    const candidates = requests.map(request => request.task.match(/Write and test your candidate ONLY at (.+?);/)![1]);
    assert.notEqual(candidates[0], candidates[1]);
    assert.ok(candidates.every(candidate => candidate.startsWith(join(root, "build/subagents/"))));
    assert.equal(readFileSync(join(root, ".git/config"), "utf8").includes("worktree"), false);
    assert.ok(requests.every(request => request.model === "fixture/worker"));
    assert.deepEqual(tools, ["read", "edit", "write", "bash"]);
  });
});
