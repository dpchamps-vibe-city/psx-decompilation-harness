import { projectRoot as currentProjectRoot } from "../../../../tools/lib/runtimeContext.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionBaseline } from "../tools/session-baseline.ts";
import { DEFAULT_CHECKPOINT_AT_TOKENS, loadLoopConfig } from "./config.ts";
import { registerCheckpointMonitor } from "./checkpoint.ts";
import { runLoop, summarize, type AbortFlag, type LoopSinks } from "./loop.ts";
import { prepSystemPrompt, registerPrepHandoffTool, setPrepHandoffToolActive } from "./prep.ts";
import { createHandoffSink, registerHandoffTool, setHandoffToolActive } from "./handoff.ts";
import { createVerdictSink, registerPolicyVerdictTool, setVerdictToolActive } from "./policy-verdict.ts";
import { readState } from "./state.ts";
import { createTurnGate, registerTurnGate } from "./turn-gate.ts";
import { CONTROLLER_TOOL, registerControllerTool, runLoopWithSubagents, type ControllerSink } from "./controller.ts";

export const LOOP_COMMAND = "auto_decompilation_loop";

interface ParsedArgs {
  action: "run" | "status" | "stop" | "usage";
  target?: string;
  maxFunctions?: number;
}

export function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "run" };
  if (tokens[0] === "status") return { action: "status" };
  if (tokens[0] === "stop") return { action: "stop" };

  const parsed: ParsedArgs = { action: "run" };
  for (const token of tokens) {
    const limit = token.match(/^--max(?:-functions)?=(\d+)$/);
    if (limit) {
      parsed.maxFunctions = Number.parseInt(limit[1], 10);
      continue;
    }
    if (/^(?:[a-zA-Z0-9_]+::)?[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !parsed.target) {
      parsed.target = token;
      continue;
    }
    return { action: "usage" };
  }
  if (parsed.maxFunctions !== undefined && parsed.maxFunctions < 1) return { action: "usage" };
  return parsed;
}

/**
 * `/auto_decompilation_loop` — the in-TUI escalation loop.
 *
 * Without subagents this retains the serial in-session ladder. With subagents,
 * the ladder supervises isolated workers; byte/build/policy oracles still own
 * completion, and integration remains serial.
 */
export function registerAutoloopCommands(pi: ExtensionAPI): () => boolean {
  const sink: LoopSinks = { verdict: createVerdictSink(), handoff: createHandoffSink(), prep: {}, gate: createTurnGate(), checkpoint: {} };
  registerPolicyVerdictTool(pi, sink.verdict);
  registerHandoffTool(pi, sink.handoff);
  registerPrepHandoffTool(pi, sink.prep);
  registerTurnGate(pi, sink.gate);
  registerCheckpointMonitor(pi, sink.checkpoint!);

  const controller: ControllerSink = {};
  registerControllerTool(pi, controller);
  let active: AbortFlag | null = null;
  let running: Promise<unknown> | undefined;
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!active) return;
    active.aborted = true;
    ctx.abort();
    await running;
  });

  /* These are turn-scoped instruments: they stay out of the ordinary active set
   * until the loop opens a policy review or a handoff. */
  pi.on("session_start", async () => {
    setVerdictToolActive(pi, false);
    setHandoffToolActive(pi, false);
    setPrepHandoffToolActive(pi, false);
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== CONTROLLER_TOOL));
  });

  /* Interactive input while the loop runs is the stop signal. The loop's own
   * messages carry source="extension", so it never interrupts itself. */
  pi.on("input", async (event) => {
    if (active && event.source === "interactive") active.aborted = true;
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    if (active && !active.aborted && sink.role === "prep") {
      return { systemPrompt: prepSystemPrompt(event.systemPromptOptions) };
    }
  });

  pi.registerCommand(LOOP_COMMAND, {
    description:
      "Run the tiered escalation decompilation loop in this session. Usage: /auto_decompilation_loop [function] [--max=N] | status | stop",
    handler: async (args, ctx) => {
      const projectRoot = currentProjectRoot();
      const parsed = parseArgs(args);

      if (parsed.action === "usage") {
        ctx.ui.notify(`Usage: /${LOOP_COMMAND} [function] [--max=N] | status | stop`, "warning");
        return;
      }

      if (parsed.action === "stop") {
        if (!active) {
          ctx.ui.notify("No escalation loop is running.", "info");
          return;
        }
        active.aborted = true;
        ctx.ui.notify("Escalation loop will stop at the next checkpoint.", "info");
        return;
      }

      let config: ReturnType<typeof loadLoopConfig>;
      try {
        config = loadLoopConfig(projectRoot);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (parsed.action === "status") {
        const state = readState(config);
        const parked = Object.keys(state.parked);
        const approvals = Object.keys(state.approvals);
        ctx.ui.notify(
          [
            `ladder: ${config.ladder.map((tier) => tier.label + (tier.role ? ` [${tier.role}]` : "")).join(" → ")}`,
            `checkpoints: ${config.ladder.map((tier) => `${tier.label}: ${tier.checkpointAtTokens ?? DEFAULT_CHECKPOINT_AT_TOKENS} tokens (0 = off)`).join("; ")}`,
            `returns per tier: ${config.returnsPerTier}`,
            `mode: ${config.subagents ? `controller (${config.subagents.quantity} workers on ${config.subagents.model.provider}/${config.subagents.model.model})` : "serial"}`,
            `running: ${active ? "yes" : "no"}`,
            ...(controller.batch ? [JSON.stringify(controller.batch.snapshot()).slice(0, 16_000)] : []),
            `parked (${parked.length}): ${parked.join(", ") || "none"}`,
            `agent-approved exemptions (${approvals.length}): ${approvals.join(", ") || "none"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (active) {
        ctx.ui.notify("An escalation loop is already running. Send any message, or /auto_decompilation_loop stop.", "warning");
        return;
      }

      const lock = join(config.runtimeDir, "active.json");
      mkdirSync(config.runtimeDir, { recursive: true });
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }) + "\n", { flag: "wx" }); }
      catch { ctx.ui.notify("Autoloop active.json lock exists; stop the other loop or remove a stale lock before restarting.", "error"); return; }
      const flag: AbortFlag = { aborted: false };
      active = flag;
      controller.unsafe = false;
      ctx.ui.notify(
        `Escalation loop starting. Ladder: ${config.ladder.map((tier) => tier.label + (tier.role ? ` [${tier.role}]` : "")).join(" → ")}. Type any message to stop.`,
        "info",
      );

      const task = Promise.resolve().then(async () => {
        const deps = { pi, ctx, projectRoot, config, sink, flag, baseline: await getSessionBaseline(projectRoot) };
        const options = { firstTarget: parsed.target, maxFunctions: parsed.maxFunctions };
        return config.subagents ? runLoopWithSubagents(deps, options, controller) : runLoop(deps, options);
      });
      running = task.catch(() => {});
      try {
        const outcomes = await task;
        ctx.ui.notify(summarize(outcomes), "info");
      } catch (error) {
        ctx.ui.notify(`Escalation loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        if (!controller.unsafe) rmSync(lock, { force: true });
        else ctx.ui.notify("Worker shutdown is unconfirmed. Retaining active.json and all workspaces; inspect the fleet before restarting.", "error");
        active = null;
        running = undefined;
      }
    },
  });
  return () => active !== null;
}
