import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { HARNESS_ROOT } from "../../../../tools/lib/runtimeContext.js";
import { WorkBatch, type WorkerJob } from "./controller-pool.js";
import { snapshotSource, stageWorkerDraft } from "./controller-integration.js";
import { sourceRelativePath } from "./park.js";
import { commitMatchedFunction } from "./commit.js";
import { writeState } from "./state.js";
import { buildInputs, inputIdentity, recordsFileGroupings, type Completion } from "../tools/prepared-attempt.js";
import { finalize, nextTarget } from "./oracles.js";
import { runLoop, turn, type LoopDeps, type LoopOptions } from "./loop.js";
import { startWorker, workerAgent } from "./subagents.js";
import type { FunctionOutcome, LoopState } from "./types.js";

export const CONTROLLER_TOOL = "psx_autoloop_workers";
export interface ControllerSink { batch?: WorkBatch; unsafe?: boolean }

export function registerControllerTool(pi: ExtensionAPI, sink: ControllerSink): void {
  pi.registerTool({ name: CONTROLLER_TOOL, label: "Autoloop workers",
    description: "Actively supervise this turn's build candidates: status/wait, steer, stop, reroute, or take over even an unfinished attempt. takeover stops the worker and hands its build candidate to you; continue it there. integrate stops the worker if needed, promotes the candidate and runs the existing finalization gate immediately. Only a passing gate means integrated; commitOnMatch commits that verified match immediately, without waiting for sibling workers. Normal main-loop close-out retains documentation and folding. Output bounded to 40 KB.",
    parameters: Type.Object({ action: StringEnum(["status", "wait", "steer", "stop", "reroute", "takeover", "integrate"] as const),
      slot: Type.Optional(Type.Integer({ minimum: 0 })), message: Type.Optional(Type.String({ maxLength: 6000 })) }),
    async execute(_id, params) {
      if (!sink.batch) throw new Error("No main-loop worker batch is running");
      let receipt: unknown;
      if (params.action !== "status") {
        if (params.action !== "wait" && params.slot === undefined) throw new Error("slot is required");
        if (params.action === "steer" && !params.message?.trim()) throw new Error("steer requires a message");
        receipt = await sink.batch.control(params.action, params.slot, params.message);
      }
      const workers = sink.batch.snapshot();
      return { content: [{ type: "text", text: JSON.stringify(["steer", "takeover", "integrate"].includes(params.action) ? { receipt, workers } : workers, null, 2).slice(0, 40_000) }], details: {} };
    },
  });
}

/** ONE ordinary runLoop. Only its work-turn implementation is replaced with
 * fan-out; no worker receives an autoloop, ladder or independent queue. */
export async function runLoopWithSubagents(deps: LoopDeps, options: LoopOptions, controller: ControllerSink): Promise<FunctionOutcome[]> {
  const workers = deps.config.subagents!;
  const registration = await workerAgent(deps.pi, join(HARNESS_ROOT, ".pi/extensions/psx-decomp/worker.ts"));
  const ownerRunId = randomUUID();
  const selected = new Set<string>();
  const pending = new Map<string, WorkerJob>();
  const feedback = new Map<string, string>();
  const committed = new Map<string, string>();
  const promotions = new Map<string, Array<() => Promise<void>>>();
  const rollback = async (name: string) => {
    const writes = promotions.get(name) ?? [];
    while (writes.length) { await writes.at(-1)!(); writes.pop(); }
    promotions.delete(name);
  };
  const limit = options.maxFunctions ?? deps.config.maxFunctions;
  const journal = () => writeFileSync(join(deps.config.runtimeDir, "controller.json"), JSON.stringify({
    ownerRunId, pid: process.pid, unsafe: controller.unsafe ?? false,
    batch: controller.batch?.snapshot(), pending: [...pending.values()].map(job => ({ functionName: job.functionName, cwd: job.cwd })),
  }, null, 2) + "\n");
  const stage = async (job: WorkerJob) => {
    if (!job.draft || job.takeover?.integrated) return;
    const result = await stageWorkerDraft(deps.projectRoot, job.draft);
    feedback.set(job.functionName, result.feedback);
    if (result.rollback) promotions.set(job.functionName, [...(promotions.get(job.functionName) ?? []), result.rollback]);
  };
  const prepare = async (functionName: string) => {
    selected.add(functionName);
    const job = pending.get(functionName);
    if (!job) return;
    pending.delete(functionName);
    await stage(job);
  };
  const work = async (current: LoopDeps, state: LoopState, functionName: string, message: string): Promise<boolean> => {
    const savedTools = current.pi.getActiveTools();
    const claimed = new Set([functionName]);
    const next = async () => {
      if (selected.size + pending.size + [...claimed].filter(name => !selected.has(name)).length >= limit) return undefined;
      const skip = new Set([...selected, ...pending.keys(), ...claimed, ...Object.keys(state.parked)]);
      const name = await nextTarget(current.projectRoot, skip);
      if (name) claimed.add(name);
      return name;
    };
    let integrating = Promise.resolve();
    const integrate = (job: WorkerJob) => {
      const task = integrating.then(async () => {
        if (current.flag.aborted) return { integrated: false, feedback: "Loop stopped; the unfinished build candidate is preserved" };
        if (!job.draft) return { integrated: false, feedback: "No build candidate was returned" };
        const staged = await stageWorkerDraft(current.projectRoot, job.draft);
        if (!staged.applied) return { integrated: false, feedback: staged.feedback };
        const undo = async () => {
          try { await staged.rollback?.(); }
          catch (error) { current.flag.aborted = true; controller.unsafe = true; throw error; }
        };
        let result: Awaited<ReturnType<typeof finalize>>;
        try { result = await finalize({ projectRoot: current.projectRoot, baseline: current.baseline, state }, job.functionName); }
        catch (error) {
          await undo();
          return { integrated: false, feedback: `Finalization failed; promotion rolled back, build draft retained: ${String(error)}` };
        }
        if (result.passed && job.functionName !== functionName && current.libraryPartBases?.has(job.draft.source.path)) {
          /* A later park of the current function must preserve this verified sibling. */
          current.libraryPartBases.set(job.draft.source.path, readFileSync(join(current.projectRoot, job.draft.source.path), "utf8"));
        }
        if (!result.passed) {
          await undo();
          return { integrated: false,
            feedback: `Taken over, but not accepted; promotion rolled back. Continue the build draft and rerun integrate: ${result.gate.failures.join("; ").slice(-5000)}` };
        }
        promotions.delete(job.functionName);
        const inputs = buildInputs(current.projectRoot);
        const completion: Completion = { origin: "agent", tier: current.sink.tier?.label ?? workers.model.label,
          verifiedIdentity: inputIdentity(inputs), inputs, verification: "passed", changedFiles: result.changedFiles,
          documentation: current.config.updateFileGroupings && recordsFileGroupings(current.projectRoot) ? "pending" : "skipped" };
        state.completions = { ...state.completions, [job.functionName]: completion };
        writeState(current.config, state);
        if (current.config.commitOnMatch) {
          const commit = await commitMatchedFunction(current.projectRoot, job.functionName, completion.tier!, result.changedFiles, completion);
          if (commit.failed) {
            current.flag.aborted = true;
            const detail = `Loop stopped: ${job.functionName} matched but was not committed — ${commit.detail}`;
            current.ctx.ui.notify(detail, "error");
            return { integrated: true, feedback: detail };
          }
          if (commit.committed) {
            completion.commit = commit.detail;
            committed.set(job.functionName, commit.detail);
            writeState(current.config, state);
            current.ctx.ui.notify(`Committed ${job.functionName} as ${commit.detail}`, "info");
          }
        }
        return { integrated: true, ...(completion.commit ? { commit: completion.commit } : {}),
          feedback: `Taken over, integrated and passed the existing byte/build/policy finalization gate; ${completion.commit
            ? `committed as ${completion.commit}` : current.config.commitOnMatch ? "no new changes to commit" : "commitOnMatch is disabled"}. Documentation and folding remain with normal main-loop close-out` };
      });
      integrating = task.then(() => {}, () => {});
      return task;
    };
    const batch = new WorkBatch(async (slot, name, suggestion) => {
      current.ctx.ui.setStatus("autoloop", `starting worker ${slot + 1}/${workers.quantity} · ${name}`);
      const directory = join(current.projectRoot, "build", "subagents", ownerRunId, randomUUID());
      mkdirSync(directory, { recursive: true });
      const source = snapshotSource(current.projectRoot, sourceRelativePath(current.projectRoot, name));
      const draft = { source, candidate: join(directory, "candidate.c"), headerPatch: join(directory, "headers.patch") };
      writeFileSync(draft.candidate, source.text ?? "");
      const role = current.sink.role === "prep" ? "psx-prepare-function" : "psx-decompile-function";
      const task = [
        `Assigned function: ${name}. Shared project cwd: ${current.projectRoot}.`,
        `Write and test your candidate ONLY at ${draft.candidate}; use ${directory} for other artifacts.`,
        `Live source ${source.path} is read-only to workers. Do not edit src/, include/, configs/ or other main-tree inputs.`,
        `If declarations need changing, put a proposed unified diff in ${draft.headerPatch}; the main agent applies it when promoting your candidate.`,
        "Pass your build candidate explicitly as src/source to diagnostic tools. Do not run live-source finalization; the main loop does that after promotion.",
        `Read ${join(HARNESS_ROOT, `.pi/skills/${role}/SKILL.md`)} and follow it.`,
        "You are one worker in ONE main autoloop turn. Do not start an autoloop, select another function, park, commit, stage, or delegate.",
        "The main loop owns the ladder, policy review, final verification, documentation and folding. Return your draft, measured evidence and blockers to that loop.",
        "Do not create a worktree, branch, second project copy, or run split/split-all. All testing uses this project's existing inputs and your build candidate.",
        `Worker checkpointAtTokens: ${workers.model.checkpointAtTokens ?? 350_000}. Preserve concise experiment summaries and use native context management.`,
        `Previous proposal feedback: ${feedback.get(name) ?? "none"}`,
        name === functionName ? message : "Prepare a measured clean-C matching candidate for the assigned function.",
        suggestion ? `Controller suggestion: ${suggestion}` : "",
      ].filter(Boolean).join("\n");
      const handle = startWorker(current.pi, { ownerRunId, nodeId: `${slot}-${randomUUID()}`, agent: registration.name,
        task, cwd: current.projectRoot, model: workers.model,
        timeoutMs: current.config.tierMinutes ? Math.min(2_147_483_647, current.config.tierMinutes * 60_000) : 2_147_483_647 });
      return { slot, functionName: name, cwd: current.projectRoot, draft, handle };
    }, next, integrate);
    controller.batch = batch;
    try {
      if (current.flag.aborted) return false;
      await batch.add(functionName);
      while (batch.jobs.length < workers.quantity && !current.flag.aborted) {
        const name = await next();
        if (!name) break;
        await batch.add(name);
      }
      journal();
      current.pi.setActiveTools([...new Set([...savedTools, CONTROLLER_TOOL])]);
      const answered = await turn(current, [
        "You are supervising the worker batch for this existing autoloop work turn. The workers are already launched; do not launch another loop or fleet.",
        "Actively check tasks with psx_autoloop_workers and inspect their build candidates and measurements. Do not merely wait for workers to announce completion.",
        "If you see a solution, call integrate immediately: it stops that worker, waits for settlement and uses the existing finalization gate and configured commitOnMatch immediately while other workers continue.",
        "You may also take over an UNFINISHED attempt at any point with takeover. Stop that worker, continue its partial candidate under build/ yourself, then call integrate when ready. A takeover alone is not a match.",
        "Steer suggestions, stop or reroute when useful. Keep the existing loop's task and completion rules.",
        "Workers return drafts, not acceptance decisions. The ordinary main loop checks each selected function, escalates it, parks it or folds its member exactly as before.",
        "Supervise this batch until the work settles, then return. Do not edit the same draft while a worker owns it.",
        `Current main-loop target: ${functionName}.`,
        JSON.stringify(batch.snapshot()).slice(0, 28_000),
      ].join("\n"));
      await batch.finish(() => current.flag.aborted || !answered);
      if (!answered || current.flag.aborted) return false;
      for (const job of batch.jobs) {
        if (job.stopped && !job.takeover?.integrated) continue;
        if (!job.takenOver && job.handle.result?.status !== "completed") throw new Error(`Worker ${job.functionName} ${job.handle.result?.status}: ${job.handle.result?.error ?? "see its retained artifacts"}`);
        if (job.functionName === functionName) await stage(job);
        else pending.set(job.functionName, job);
      }
      return true;
    } finally {
      try { await batch.close(); }
      catch (error) { controller.unsafe = true; throw error; }
      finally { journal(); delete controller.batch; current.pi.setActiveTools(savedTools); }
    }
  };
  try {
    return await runLoop({ ...deps, work: { prepare, turn: work, committed: name => committed.get(name), next: (skip, defer) => {
      const ready = [...pending.keys()].filter(name => !skip.has(name));
      return ready.find(name => !defer.has(name)) ?? ready[0];
    }, settled: async (name, outcome) => {
      if (outcome.kind === "aborted" || outcome.kind === "environment-broken") await rollback(name);
      else promotions.delete(name);
    } } }, options);
  } catch (error) {
    try { for (const name of [...promotions.keys()].reverse()) await rollback(name); }
    catch (restoreError) { controller.unsafe = true; throw new AggregateError([error, restoreError], "Autoloop failed and worker promotion rollback needs review"); }
    throw error;
  } finally {
    journal();
    registration.dispose();
    /* Unselected candidates remain under build/, not mixed into main source. */
  }
}
