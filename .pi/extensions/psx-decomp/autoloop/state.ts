import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AutodecompConfig } from "../../shared/types.ts";
import type { ApprovalRecord, LoopConfig, LoopState, ParkRecord } from "./types.ts";
import { inputIdentity, type Completion } from "../tools/prepared-attempt.ts";
import { count } from "../../../../tools/lib/perfCounters.js";

export function statePath(config: LoopConfig): string {
  return join(config.runtimeDir, "state.json");
}

export function emptyState(): LoopState {
  return { parked: {}, approvals: {} };
}

export function readState(config: LoopConfig): LoopState {
  const path = statePath(config);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LoopState>;
    return { parked: raw.parked ?? {}, approvals: raw.approvals ?? {}, ...(raw.completions ? { completions: raw.completions } : {}) };
  } catch {
    return emptyState();
  }
}

/* A completion's verified input map is persisted once, content-addressed by its
   identity, and the state keeps the identity only: the state no longer grows by
   a whole-tree map per match. A record whose map and identity disagree stays as
   it is. Older states with inline maps load unchanged and slim on their next write. */
const persisted = new WeakSet<Completion>();
function persistedCompletion(config: LoopConfig, completion: Completion): Completion {
  if (!completion.inputs) return completion;
  if (!persisted.has(completion)) {
    if (inputIdentity(completion.inputs) !== completion.verifiedIdentity) return completion;
    const sidecar = join(config.runtimeDir, "inputs", `${completion.verifiedIdentity}.json`);
    if (!existsSync(sidecar)) {
      mkdirSync(dirname(sidecar), { recursive: true });
      const temp = `${sidecar}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(completion.inputs)}\n`);
      renameSync(temp, sidecar);
    }
    persisted.add(completion);
  }
  const { inputs: _verified, ...slim } = completion;
  return slim;
}

export function writeState(config: LoopConfig, state: LoopState): void {
  const path = statePath(config);
  mkdirSync(dirname(path), { recursive: true });
  const stored: LoopState = state.completions ? { ...state, completions: Object.fromEntries(Object.entries(state.completions)
    .map(([name, completion]) => [name, persistedCompletion(config, completion)])) } : state;
  const temp = `${path}.tmp`, text = `${JSON.stringify(stored, null, 2)}\n`;
  count("state.write"); count("state.write.bytes", text.length);
  writeFileSync(temp, text);
  renameSync(temp, path);
}

export function recordPark(config: LoopConfig, state: LoopState, record: ParkRecord): LoopState {
  const next: LoopState = { ...state, parked: { ...state.parked, [record.functionName]: record } };
  writeState(config, next);
  return next;
}

export function recordApproval(config: LoopConfig, state: LoopState, record: ApprovalRecord): LoopState {
  const next: LoopState = { ...state, approvals: { ...state.approvals, [record.functionName]: record } };
  writeState(config, next);
  return next;
}

/**
 * Project the loop's own decisions onto the shared source-policy allowlist.
 *
 * A loop park may restore `INCLUDE_ASM` on purpose; a selection-only park does
 * not grant that exemption. An agent-approved exemption has been adjudicated
 * one rung up the ladder — both loop decisions must stop the
 * gate from failing every *later* function whose patch happens to contain
 * those lines. Neither is written into `.pi/autoloop.json`: that allowlist is
 * the human's permanent assertion about a function, and the loop only ever
 * files a request for one (see the approvals directory).
 */
export function withLoopExemptions(config: AutodecompConfig, state: LoopState): AutodecompConfig {
  const allowlist: Record<string, string[]> = { ...config.sourcePolicy.allowlist };
  const add = (name: string, kinds: string[]) => {
    const key = name.toLowerCase();
    allowlist[key] = [...new Set([...(allowlist[key] ?? []), ...kinds])];
  };
  for (const [name, record] of Object.entries(state.parked)) {
    if (!record.skipOnly) add(name, ["include-asm"]);
  }
  for (const [name, approval] of Object.entries(state.approvals)) add(name, approval.kinds);
  return { ...config, sourcePolicy: { ...config.sourcePolicy, allowlist } };
}
