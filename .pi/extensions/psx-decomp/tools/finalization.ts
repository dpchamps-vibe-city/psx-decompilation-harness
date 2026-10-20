import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";
import { createTreeFromWorktree, changedFilesBetweenTrees, treePatch } from "../../shared/workspace.ts";
import { loadCallGraph } from "../../shared/call-graph.ts";
import { diffResultFromCommand, runGate } from "../../shared/gates.ts";
import { runCommand } from "../../shared/process.ts";
import type { AutodecompConfig, CommandResult, GateResult } from "../../shared/types.ts";
import { Timings } from "../../../../tools/lib/contentCache.js";
import type { ExportResult } from "../../../../tools/agent/contextExport.js";
import { loadLibraryProject } from "../../../../tools/lib/project.js";
import { libraryMembers, libraryTargetKey, requireLibraryFunction, scopedLibraryMembers, withLibraryMetadata } from "../../../../tools/lib/libraryTargets.js";
import { libraryFunctionSource, libraryGeneratedSymbols, libraryMembersOwning } from "../../../../tools/lib/libraryTranslationUnit.js";
import { compilerInputs, consumeReceipt, contextIsCompilerIndependent, publishReceipt, verificationOutputs } from "./verification-receipt.ts";
import { libraryReceiptMembers, publishLibraryReceipt, validLibraryReceipt } from "./library-receipt.ts";
import type { LibraryGateStep } from "../../../../tools/agent/libraryFinalizeGate.js";
import { libraryFunctionTarget } from "../../../../tools/lib/targetAdapter.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One authoritative route. Machine work can be reused only across unchanged
 * inputs/outputs in this workspace; context publication and scope still gate. */
export async function finalizeWorkspace(options: {
  projectRoot: string; config: AutodecompConfig; functionName: string;
  changedFiles: string[]; patch: string; signal?: AbortSignal;
  /** Called once the machine verification (diff and member check) has passed. */
  onMachineVerified?: () => void;
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
    const { LIBRARY_GATE_STATUS, LIBRARY_GATE_VERIFIED } = await import("../../../../tools/agent/libraryFinalizeGate.js");
    options.signal?.throwIfAborted();
    const members = libraryMembers(options.projectRoot);
    /* One inventory for the whole finalization. Outside it, every member lookup
       (the input guard makes several per checked member) re-reads and re-parses
       every input object. */
    return withLibraryMetadata(async () => {
      // Finishing targets (the generated data/symbol parts) resolve like functions.
      const names = (m: (typeof members)[number]) => [...m.functions.map(f => f.name), ...libraryGeneratedSymbols(m)];
      const sources = Object.fromEntries(members.flatMap(m => names(m).map(n => [libraryTargetKey(m, n), libraryFunctionSource(m, n)])));
      const containers = Object.fromEntries(members.flatMap(m => names(m).map(n => [libraryTargetKey(m, n), m.id])));
      const target = requireLibraryFunction(options.functionName, options.projectRoot);
      const active = [...new Set([target.member.id, ...libraryMembersOwning(members, options.changedFiles, options.projectRoot).map(m => m.id)])];
      const checkedMembers = libraryVerificationMembers(active, options.projectRoot, members);
      const gateOptions = { ...options, functionName: target.key, mode: "match" as const, runBuild: true,
        functionSources: sources, functionContainers: containers, functionContainer: target.member.id };
      /* This process already verified this function on these exact inputs:
         reuse the machine work, never scope or policy. */
      const reuse = await timings.measure("receipt-validation", () => validLibraryReceipt(options.projectRoot, target.key, target, checkedMembers));
      if (reuse.gate) {
        const gate = await timings.measure("receipt-policy-scope", () => runGate({ ...gateOptions, machineVerification: reuse.gate! }));
        const stillFresh = await timings.measure("receipt-revalidation", () => validLibraryReceipt(options.projectRoot, target.key, target, checkedMembers));
        if (!stillFresh.gate) { gate.pass = false; gate.failures.push(`Receipt invalidated during policy/scope check: ${stillFresh.reason}; rerun finalization`); }
        gate.cache = { hit: true, reason: reuse.reason }; gates.push(gate);
        contextPublication = reuse.gate.contextPublication;
        return done(gate);
      }
      const identity = () => timings.measureSync("library-inputs", () => libraryWorkspaceIdentity(checkedMembers, options.projectRoot));
      const before = identity();
      /* Diff, member check and publication run as one child (one inventory, one
         memo), each step reporting what its own CLI reported. Publication there
         precedes the gate's verdict, so it is staged: the context files are
         restored unless the gate passes. */
      const context = libraryFunctionTarget(target.member, target.fn, options.projectRoot).context;
      const contextFiles = [context.types, context.functions].map(path => join(options.projectRoot, path));
      const staged = contextFiles.map(path => existsSync(path) ? readFileSync(path) : null);
      let steps: LibraryGateStep[] | undefined, unified: CommandResult | undefined;
      const step = (name: LibraryGateStep["step"]): CommandResult | undefined => {
        const found = steps?.find(s => s.step === name);
        return found && unified && { command: `${unified.command} [${name}]`, code: found.code, signal: null, timedOut: false, stdout: found.stdout, stderr: found.stderr, durationMs: found.durationMs };
      };
      const machineRunner = async (activeMembers: string[]) => {
        unified = await runCommand(process.execPath, installedScriptArgs("tools/agent/libraryFinalizeGate.ts",
          [target.key, ...activeMembers.flatMap(id => ["--member", id]), "--publish", options.functionName], options.projectRoot),
          { cwd: options.projectRoot, signal: options.signal, timeoutMs: 6 * 60_000, maxCaptureBytes: 8 * 1024 * 1024,
            /* Machine verification passed while publication still runs. */
            onStdoutLine: line => { if (line === LIBRARY_GATE_VERIFIED) options.onMachineVerified?.(); } });
        const line = unified.stdout.split("\n").find(l => l.startsWith(LIBRARY_GATE_STATUS));
        try { steps = (JSON.parse(line!.slice(LIBRARY_GATE_STATUS.length)) as { steps: LibraryGateStep[] }).steps; } catch { steps = undefined; }
        /* A child that failed before reporting failed the diff step: its own output is the failure. */
        if (!steps) return { diff: diffResultFromCommand(target.key, unified) };
        const check = step("check");
        return { diff: diffResultFromCommand(target.key, step("diff")!), ...(check ? { build: check } : {}) };
      };
      const restoreContext = () => contextFiles.forEach((path, i) => { if (staged[i] === null) rmSync(path, { force: true }); else writeFileSync(path, staged[i]!); });
      const gate = await timings.measure("library-gate", () => runGate({ ...gateOptions, machineRunner }));
      gates.push(gate);
      if (!gate.pass) { if (step("publish")) restoreContext(); return done(gate); }
      options.onMachineVerified?.();
      const publication = step("publish") ?? await timings.measure("context-export", () => runCommand(process.execPath, installedScriptArgs("tools/agent/contextExport.ts", [options.functionName], options.projectRoot), {
        cwd: options.projectRoot, signal: options.signal, timeoutMs: 120_000,
      }));
      const status = publication.stdout.split("\n").find(line => line.startsWith(CONTEXT_EXPORT_STATUS));
      try {
        const result = JSON.parse(status?.slice(CONTEXT_EXPORT_STATUS.length) ?? "null") as ExportResult | null;
        if (result?.status === "published" && result.signatureMatches) contextPublication = { ...result, command: publication };
      } catch { /* No publication outcome is not a pass. */ }
      if (publication.code !== 0 || !contextPublication || options.signal?.aborted) {
        if (step("publish") && options.signal?.aborted) restoreContext();
        gate.pass = false; gate.failures.push(`Context export failed or was cancelled; rerun finalization.\n${publication.stdout}\n${publication.stderr}`);
      } else if (before !== identity()) {
        // One guard after publication covers the member gate too: both windows end here.
        gate.pass = false; gate.failures.push("Library inputs changed during finalization; rerun the member gate");
      } else {
        await timings.measure("receipt-publication", () => publishLibraryReceipt(options.projectRoot, target.key, target, checkedMembers, { ...gate, contextPublication: contextPublication! }));
      }
      // Relocatable verification cannot consume a linked-image receipt.
      return done(gate);
    }, members, options.projectRoot);
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
export async function finalizedDiff(projectRoot: string, functionName: string, config: AutodecompConfig) {
  if (!loadLibraryProject(projectRoot)) return consumeReceipt(projectRoot, functionName, config).gate?.diff;
  /* The diff is a fact about the function's bytes; the receipt's own member set
     decides whether those inputs are unchanged. */
  return withLibraryMetadata(async () => {
    const target = requireLibraryFunction(functionName, projectRoot), ids = libraryReceiptMembers(projectRoot, target.key);
    if (!ids) return undefined;
    const checked = scopedLibraryMembers(projectRoot).filter(m => ids.includes(m.id));
    return (await validLibraryReceipt(projectRoot, target.key, target, checked)).gate?.diff;
  }, undefined, projectRoot);
}
