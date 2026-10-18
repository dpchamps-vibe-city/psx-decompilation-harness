import { installedScriptArgs } from "../../../tools/lib/installedScripts.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallGraph, CallGraphEntry, ControllerState, FunctionKey, FunctionState } from "./types.ts";
import { runCommand } from "./process.ts";
import { resolveFunctionTarget } from "../../../tools/lib/targetAdapter.js";

/** The container a call graph entry belongs to when the graph does not say. */
export const DEFAULT_CONTAINER = "exe";

export function normalizeVram(value: string): string {
  // Library queue coordinates are symbolic, never fabricated RAM addresses.
  // Keep the legacy field for controller-state compatibility, with an explicit tag.
  if (/^symbol:[A-Za-z_]\w*$/.test(value)) return value;
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid VRAM address: ${value}`);
  return `0x${parsed.toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * The one identity for a function in controller state.
 *
 * Two overlays that share a RAM slot hold different functions at the same
 * address, so the address alone collides. The container is the disambiguator
 * and it goes in front, which also makes the sort tiebreak group a container's
 * work together instead of interleaving two address spaces.
 */
export function functionKey(container: string, vram: string): FunctionKey {
  return `${container || DEFAULT_CONTAINER}:${normalizeVram(vram)}`;
}

/** Split a key back into its parts. Throws rather than guessing at a bare VRAM. */
export function parseFunctionKey(key: FunctionKey): { container: string; vram: string } {
  const index = key.indexOf(":");
  if (index <= 0) throw new Error(`Not a function key: ${key}`);
  return { container: key.slice(0, index), vram: normalizeVram(key.slice(index + 1)) };
}

/** The key for one function's state record. */
export function keyOf(fn: Pick<FunctionState, "container" | "vram">): FunctionKey {
  return functionKey(fn.container, fn.vram);
}

export function loadCallGraph(projectRoot: string): CallGraph {
  const path = join(projectRoot, "build", "callGraph.json");
  if (!existsSync(path)) throw new Error(`Missing call graph: ${path}`);
  const graph = JSON.parse(readFileSync(path, "utf8")) as CallGraph;
  if (!Array.isArray(graph.functions)) throw new Error(`Invalid call graph: ${path}`);
  for (const entry of graph.functions) {
    if (typeof entry.dead !== "boolean") throw new Error(`Call graph entry ${entry.name} has no dead classification`);
    entry.vram = normalizeVram(entry.vram);
    /* A graph generated before containers existed names none. Defaulting to the
       executable is right for exactly that graph and wrong for any other, so it
       is a default here and a required field there — callGraph.ts emits it. */
    entry.container ||= DEFAULT_CONTAINER;
  }
  return graph;
}

/**
 * Where one function's translation unit and original assembly live.
 *
 * The call graph is the authority: it is generated from each container's own
 * configuration, so it knows layouts this module never has to learn. The
 * fallback is the executable's layout, which is the only one that can be
 * assumed when there is no graph yet — a fresh checkout, or a tool running
 * before the first `make disassemble`.
 */
export function functionPaths(projectRoot: string, name: string): {
  container: string;
  source: string;
  includeAsmPath: string;
} {
  const target = resolveFunctionTarget(name, projectRoot);
  return { container: target.owner.id, source: target.source, includeAsmPath: target.includeAsm.folder };
}

export async function rebuildCallGraph(projectRoot: string, timeoutMs = 120_000): Promise<CallGraph> {
  const result = await runCommand(process.execPath, installedScriptArgs("tools/agent/callGraph.ts", [], projectRoot), { cwd: projectRoot, timeoutMs });
  if (result.code !== 0) throw new Error(`Call graph regeneration failed:\n${result.stderr || result.stdout}`);
  return loadCallGraph(projectRoot);
}

export function graphHash(graph: CallGraph): string {
  const stable = graph.functions
    .map((entry) => ({
      key: functionKey(entry.container, entry.vram),
      vram: normalizeVram(entry.vram),
      name: entry.name,
      decompiled: entry.decompiled,
      libraryStub: entry.libraryStub,
      dead: entry.dead,
      handwritten: entry.handwritten,
      calls: [...entry.calls].sort(),
      calledBy: [...entry.calledBy].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function eligible(entry: CallGraphEntry): boolean {
  return entry.dead === false && entry.handwritten === false && entry.libraryStub !== false;
}

export function reconcileState(state: ControllerState, graph: CallGraph): void {
  const seen = new Set<FunctionKey>();
  for (const entry of graph.functions) {
    const vram = normalizeVram(entry.vram);
    const key = functionKey(entry.container, vram);
    seen.add(key);
    const current = state.functions[key];
    if (!current) {
      state.functions[key] = {
        container: entry.container,
        vram,
        currentName: entry.name,
        previousNames: [],
        status: entry.dead ? "dead" : entry.handwritten !== false ? "handwritten" : "pending",
        priority: entry.priority,
        tier: entry.tier,
        graphDecompiled: entry.decompiled,
        libraryStub: entry.libraryStub,
        dead: entry.dead,
        handwritten: entry.handwritten,
        attempts: [],
        attemptsThisEpoch: 0,
      };
      continue;
    }

    if (current.currentName !== entry.name) {
      if (!current.previousNames.includes(current.currentName)) current.previousNames.push(current.currentName);
      current.currentName = entry.name;
    }
    current.priority = entry.priority;
    current.tier = entry.tier;
    current.graphDecompiled = entry.decompiled;
    current.libraryStub = entry.libraryStub;
    current.dead = entry.dead;
    current.handwritten = entry.handwritten;

    if (entry.dead) current.status = "dead";
    else if (entry.handwritten !== false) current.status = "handwritten";
    else if (current.status === "dead" || current.status === "handwritten") current.status = "pending";
  }

  for (const [key, current] of Object.entries(state.functions)) {
    if (!seen.has(key) && current.status !== "matched") {
      current.status = "manually-skipped";
      current.parkedReason = "Function disappeared from the regenerated call graph";
    }
  }
  state.graphHash = graphHash(graph);
}

/* Names, not addresses. An overlay's symbols carry their container as a prefix,
   so a name is globally unique where an address is not — which makes a
   cross-container edge an ordinary lookup here rather than a special case. */
function namesToKeys(graph: CallGraph): Map<string, FunctionKey> {
  return new Map(graph.functions.map((entry) => [entry.name, functionKey(entry.container, entry.vram)]));
}

export function matchedNeighborHash(key: FunctionKey, state: ControllerState, graph: CallGraph): { hash?: string; count: number } {
  const entry = graph.functions.find((candidate) => functionKey(candidate.container, candidate.vram) === key);
  if (!entry) return { count: 0 };
  const byName = namesToKeys(graph);
  const neighbors = [...new Set([...entry.calls, ...entry.calledBy])]
    .map((name) => byName.get(name))
    .filter((neighbor): neighbor is FunctionKey => Boolean(neighbor && state.functions[neighbor]?.status === "matched"))
    .sort();
  if (neighbors.length === 0) return { count: 0 };
  return {
    count: neighbors.length,
    hash: createHash("sha256").update(neighbors.join("\n")).digest("hex"),
  };
}

export function updateNeighborHashes(state: ControllerState, graph: CallGraph, reactivateParked: boolean): void {
  for (const fn of Object.values(state.functions)) {
    if (!eligibleState(fn)) continue;
    const previous = fn.lastNeighborHash;
    const current = matchedNeighborHash(keyOf(fn), state, graph);
    fn.lastNeighborHash = current.hash;
    if (reactivateParked && fn.status === "parked" && current.hash && previous && current.hash !== previous) {
      fn.status = "retry-ready";
      fn.attemptsThisEpoch = 0;
      fn.parkedReason = undefined;
    }
  }
}

export function eligibleState(fn: FunctionState): boolean {
  return !fn.dead && fn.handwritten === false && fn.libraryStub !== false && !fn.manuallySkipped;
}
