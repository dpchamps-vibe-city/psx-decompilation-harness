import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";
import { createTreeFromWorktree, changedFilesBetweenTrees, treePatch } from "../../shared/workspace.ts";
import { loadCallGraph } from "../../shared/call-graph.ts";
import { runGate } from "../../shared/gates.ts";
import { runCommand } from "../../shared/process.ts";
import type { AutodecompConfig, GateResult } from "../../shared/types.ts";
import { Timings } from "../../../../tools/lib/contentCache.js";
import type { ExportResult } from "../../../../tools/agent/contextExport.js";
import { loadLibraryProject } from "../../../../tools/lib/project.js";
import { libraryMembers, libraryTargetKey, requireLibraryFunction } from "../../../../tools/lib/libraryTargets.js";
import { libraryFunctionSource, librarySourceFiles } from "../../../../tools/lib/libraryTranslationUnit.js";
import { compilerInputs, consumeReceipt, contextIsCompilerIndependent, publishReceipt, verificationOutputs } from "./verification-receipt.ts";

/** One authoritative route. Machine work can be reused only across unchanged
 * inputs/outputs in this workspace; context publication and scope still gate. */
export async function finalizeWorkspace(options: {
  projectRoot: string; config: AutodecompConfig; functionName: string;
  changedFiles: string[]; patch: string; signal?: AbortSignal;
}): Promise<GateResult> {
  options.signal?.throwIfAborted();
  const { CONTEXT_EXPORT_STATUS } = await import("../../../../tools/agent/contextExport.js");
  options.signal?.throwIfAborted();
  const timings = new Timings();
  const gates: GateResult[] = [];
  let contextPublication: GateResult["contextPublication"];
  const done = (gate: GateResult): GateResult => ({ ...gate, ...(contextPublication ? { contextPublication } : {}), finalizationGates: gates,
    timings: { phases: timings.phases, totalMs: timings.totalMs } });
  if (loadLibraryProject(options.projectRoot)) {
    const { libraryVerificationMembers, libraryWorkspaceIdentity } = await import("../../../../tools/agent/libraryTarget.js");
    options.signal?.throwIfAborted();
    const members = libraryMembers(options.projectRoot);
    const sources = Object.fromEntries(members.flatMap(m => m.functions.map(f => [libraryTargetKey(m, f.name), libraryFunctionSource(m, f.name)])));
    const containers = Object.fromEntries(members.flatMap(m => m.functions.map(f => [libraryTargetKey(m, f.name), m.id])));
    const target = requireLibraryFunction(options.functionName, options.projectRoot);
    const active = [...new Set([target.member.id,
      ...members.filter(m => librarySourceFiles(m, options.projectRoot).some(s => options.changedFiles.includes(s))).map(m => m.id)])];
    const checkedMembers = libraryVerificationMembers(active, options.projectRoot, members);
    const identity = () => timings.measureSync("library-inputs", () => libraryWorkspaceIdentity(checkedMembers, options.projectRoot));
    const before = identity();
    const gate = await timings.measure("library-gate", () => runGate({ ...options, functionName: target.key, mode: "match", runBuild: true,
      functionSources: sources, functionContainers: containers, functionContainer: target.member.id }));
    gates.push(gate);
    if (gate.pass && before !== identity()) { gate.pass = false; gate.failures.push("Library inputs changed during finalization; rerun the member gate"); }
    if (!gate.pass) return done(gate);
    const publication = await timings.measure("context-export", () => runCommand(process.execPath, installedScriptArgs("tools/agent/contextExport.ts", [options.functionName], options.projectRoot), {
      cwd: options.projectRoot, signal: options.signal, timeoutMs: 120_000,
    }));
    const status = publication.stdout.split("\n").find(line => line.startsWith(CONTEXT_EXPORT_STATUS));
    try {
      const result = JSON.parse(status?.slice(CONTEXT_EXPORT_STATUS.length) ?? "null") as ExportResult | null;
      if (result?.status === "published" && result.signatureMatches) contextPublication = { ...result, command: publication };
    } catch { /* No publication outcome is not a pass. */ }
    if (publication.code !== 0 || !contextPublication || options.signal?.aborted || before !== identity()) {
      gate.pass = false; gate.failures.push(`Context export failed, was cancelled or inputs changed; rerun finalization.\n${publication.stdout}\n${publication.stderr}`);
    }
    // Relocatable verification cannot consume a linked-image receipt.
    return done(gate);
  }
  const graph = loadCallGraph(options.projectRoot);
  const entry = graph.functions.find((f) => f.name === options.functionName);
  const gateOptions = {
    ...options, mode: "match" as const,
    ...(entry?.vram ? { functionVram: entry.vram } : {}),
    ...(entry?.container ? { functionContainer: entry.container } : {}),
    functionVrams: Object.fromEntries(graph.functions.map((f) => [f.name, f.vram])),
    functionContainers: Object.fromEntries(graph.functions.map((f) => [f.name, f.container])),
    functionSources: Object.fromEntries(graph.functions.map((f) => [f.name, f.source ?? `src/${f.name}.c`])),
  };
  const reuse = timings.measureSync("receipt-validation", () => consumeReceipt(options.projectRoot, options.functionName, options.config));
  if (reuse.gate) {
    const gate = await timings.measure("receipt-policy-scope", () => runGate({ ...gateOptions, machineVerification: reuse.gate }));
    const stillFresh = timings.measureSync("receipt-revalidation", () => consumeReceipt(options.projectRoot, options.functionName, options.config));
    if (!stillFresh.gate) { gate.pass = false; gate.failures.push(`Receipt invalidated during policy/scope check: ${stillFresh.reason}`); }
    gate.receipt = stillFresh.gate?.receipt;
    gate.cache = { hit: true, reason: reuse.reason }; gates.push(gate);
    return done(gate);
  }
  const initialInputs = timings.measureSync("initial-inputs", () => compilerInputs(options.projectRoot, true));
  const first = await timings.measure("initial-gate", () => runGate(gateOptions));
  gates.push(first);
  if (!first.pass) return done(first);
  options.signal?.throwIfAborted();
  const before = await timings.measure("before-publication-tree", () => createTreeFromWorktree(options.projectRoot, options.projectRoot, options.config.integration.allowedRoots, options.signal));
  const beforeInputs = timings.measureSync("before-publication-inputs", () => compilerInputs(options.projectRoot, true));
  const beforeOutputs = timings.measureSync("before-publication-outputs", () => verificationOutputs(options.projectRoot, options.functionName));
  const publication = await timings.measure("context-export", () => runCommand(process.execPath, installedScriptArgs("tools/agent/contextExport.ts", [options.functionName], options.projectRoot), {
    cwd: options.projectRoot, signal: options.signal, timeoutMs: 120_000,
  }));
  options.signal?.throwIfAborted();
  const statusLine = publication.stdout.split("\n").find((line) => line.startsWith(CONTEXT_EXPORT_STATUS));
  try {
    const result = JSON.parse(statusLine?.slice(CONTEXT_EXPORT_STATUS.length) ?? "null") as ExportResult | null;
    if (result && ["published", "skipped"].includes(result.status) && typeof result.signatureMatches === "boolean")
      contextPublication = { ...result, command: publication };
  } catch { /* A missing or malformed generator outcome cannot mean success. */ }
  if (publication.code !== 0 || !contextPublication || !contextPublication.signatureMatches) return done({ ...first, pass: false,
    failures: [`Context export failed or did not publish the definition's signature: ${contextPublication?.reason ?? "missing/failed publication outcome"}\n${publication.stdout}\n${publication.stderr}`] });
  const after = await timings.measure("after-publication-tree", () => createTreeFromWorktree(options.projectRoot, options.projectRoot, options.config.integration.allowedRoots, options.signal));
  const exportedFiles = await changedFilesBetweenTrees(options.projectRoot, before, after, options.signal);
  const afterInputs = timings.measureSync("after-publication-inputs", () => compilerInputs(options.projectRoot, true));
  const independent = contextIsCompilerIndependent(options.projectRoot);
  const afterOutputs = timings.measureSync("after-publication-outputs", () => verificationOutputs(options.projectRoot, options.functionName));
  const unchanged = initialInputs === beforeInputs && beforeInputs === afterInputs && independent && beforeOutputs === afterOutputs;
  const publicationPatch = await treePatch(options.projectRoot, before, after, options.config.integration.allowedRoots, options.signal);
  const gate = await timings.measure("publication-gate", () => runGate({ ...gateOptions,
    ...(unchanged ? { machineVerification: first } : {}),
    changedFiles: [...new Set([...options.changedFiles, ...exportedFiles])].sort(),
    patch: options.patch + "\n" + publicationPatch,
  }));
  gates.push(gate);
  gate.contextPublication = contextPublication;
  options.signal?.throwIfAborted();
  gate.cache = { hit: unchanged, reason: unchanged ? "publication changed only compiler-independent context" : "compiler inputs changed or dependency coverage incomplete" };
  if (gate.pass) {
    const finalInputs = timings.measureSync("final-inputs", () => compilerInputs(options.projectRoot, true));
    const finalOutputs = timings.measureSync("final-outputs", () => verificationOutputs(options.projectRoot, options.functionName));
    if (finalInputs !== afterInputs || (unchanged && beforeOutputs !== finalOutputs)) {
      gate.pass = false; gate.failures.push("Verification inputs changed during publication gate; rerun finalization");
    } else {
      gate.receipt = timings.measureSync("receipt-publication", () => publishReceipt(options.projectRoot, options.functionName, options.config, gate));
    }
  }
  return done(gate);
}

/** The loop may skip its preliminary diff only when this process owns a fresh
 * successful finalization. finalizeWorkspace still rechecks scope and policy. */
export function finalizedDiff(projectRoot: string, functionName: string, config: AutodecompConfig) {
  if (loadLibraryProject(projectRoot)) return undefined;
  return consumeReceipt(projectRoot, functionName, config).gate?.diff;
}
