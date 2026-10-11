import { COMPONENT_CONTRACTS, compilationIdentity, stableHash } from "../lib/cacheIdentity.js";
import { currentScriptArgs } from "../lib/installedScripts.js";
import { projectRoot } from "../lib/runtimeContext.js";
/** Library-mode bridge for npm and the existing Pi preparation/diff/gate loop.
 * Iterations compile the owning TU; acceptance is the entire original member.
 * No original object is ever substituted for missing reconstructed C. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { configuredFlags, configuredTool, toolchainExecutables } from "../lib/toolchain.js";
import { libraryContext, loadLibraryProject, libraryInputFiles } from "../lib/project.js";
import { libraryInventory, libraryMembers, libraryTargetKey, materializeOriginal, requireLibraryFunction, resolveLibraryCall, type LibraryMember } from "../lib/libraryTargets.js";
import { compareRelocatableObjects, readRelocatableObject, type ObjectComparison } from "../lib/relocatableObject.js";
import { libraryAssemblyParts } from "../lib/libraryAssembly.js";
import { libraryFunctionTarget } from "../lib/targetAdapter.js";
import { digest, filesUnder, snapshot } from "../lib/contentCache.js";
import { recordedCommand, commandText } from "../lib/recordedCommand.js";
import { compileSource, compileSourceAsync, configuredToolchainIdentity, loadFlagOverrides, rejectionFromDiagnostics, runTool, sourceDependencyFiles } from "./decompToolchain.js";
import { extractSignaturesFromSource } from "./sdkTypes.js";
import { analyzeCSource } from "./cSourceGuard.js";
import { emptyDeclarationIndex, indexDeclarations, projectDeclarations } from "./declarationContext.js";
import { prepareM2c } from "../build/prepareM2c.js";
import { packetOpening, packetEvidence, type PreparationPacket } from "./campaign/packet.js";
import { sourceConstructFindings } from "../../.pi/extensions/shared/source-policy.js";
import { loadConfig } from "../../.pi/extensions/shared/config.js";
const hashFile = (path: string) => existsSync(path) ? digest(readFileSync(path)) : "absent";
const acceptedPath = (root: string, member: LibraryMember) => join(root, "build/libraries/verified", `${member.id}.json`);
function memberInputPaths(member: LibraryMember, root: string): string[] {
  const p = loadLibraryProject(root)!;
  const cpp = configuredFlags("cpp", libraryContext(member.id, root), root);
  const includeDirs = cpp.flatMap((f, i) => f === "-I" ? [cpp[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
  return ["project.json", member.source, ...libraryInputFiles(p, root).map(i => i.path),
    ...includeDirs, ...p.headers.reference, ...p.headers.owned,
    ...(existsSync(join(root, member.source)) ? sourceDependencyFiles(member.source) : [])];
}
export function libraryBuildIdentity(member: LibraryMember, root = projectRoot()): string {
  if (hashFile(resolve(root, member.input)) !== member.inputHash) throw new Error(`Target input changed while measuring ${member.id}; rerun inventory`);
  return digest(JSON.stringify({ target: member.sha256, input: member.inputHash,
    tools: compilationIdentity(root, libraryContext(member.id, root), member.id),
    inputs: snapshot(root, memberInputPaths(member, root), f => !f.endsWith(".test.ts") && !f.includes("__pycache__")) }));
}
function accepted(member: LibraryMember, root: string): boolean {
  try { const record = JSON.parse(readFileSync(acceptedPath(root, member), "utf8")); return record.verdict === "match" && record.identity === libraryBuildIdentity(member, root); }
  catch { return false; }
}
export const isLibraryMemberVerified = accepted;

function compileMember(member: LibraryMember, source = member.source, root = projectRoot()) {
  const artifacts = compileSource(source, `build/libraries/candidates/${member.id}/${randomUUID()}`, member.id, { assemble: true, containerKind: "library", containerId: member.id });
  const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
  if (rejection) throw new Error(`Invalid C: ${rejection}`);
  return artifacts;
}
export function measureLibraryFunction(name: string, source?: string) {
  const target = requireLibraryFunction(name), artifacts = compileMember(target.member, source);
  const comparison = compareLibraryCandidate(target.member, artifacts);
  const report = join(artifacts.outputDir, "comparison.json");
  writeFileSync(report, JSON.stringify({ target: target.key, scope: "whole-member", memberHash: target.member.sha256, ...comparison }, null, 2) + "\n");
  return { ...target, artifacts, comparison, report };
}
function compareLibraryCandidate(member: LibraryMember, artifacts: ReturnType<typeof compileSource>): ObjectComparison {
  const object = readFileSync(artifacts.object!), comparison = compareRelocatableObjects(member.bytes, object);
  const stubs = analyzeCSource(readFileSync(artifacts.source, "utf8")).includeAsm;
  const markers = readRelocatableObject(object).symbols.filter(s => s.name.endsWith(".NON_MATCHING"));
  if (stubs.length || markers.length) return { ...comparison, verdict: "stub",
    differences: ["Member still contains INCLUDE_ASM/assembly-backed data; reference assembly is not reconstructed C", ...comparison.differences] };
  return comparison;
}
export function renderLibraryComparison(comparison: ObjectComparison): string {
  const percent = comparison.totalWords ? (comparison.matchedWords / comparison.totalWords * 100).toFixed(2) : "0.00";
  return [`target: ${comparison.totalWords} instrs, candidate: ${comparison.candidateWords} instrs`,
    `Match: ${comparison.matchedWords}/${comparison.totalWords} words (${percent}%)`,
    `VERDICT: ${comparison.verdict.toUpperCase()}`, "Scope: whole relocatable member (sections, bytes, symbols and symbolic relocations)",
    ...comparison.differences.map(d => `  ${d}`)].join("\n");
}
export function disassembleLibraryMember(member: LibraryMember, root = projectRoot()): string {
  const original = materializeOriginal(member, root), path = join(root, member.assembly);
  mkdirSync(dirname(path), { recursive: true });
  const assembly = runTool(configuredTool("spimdisasm", root), ["elfObjDisasm", original, "-", ...configuredFlags("spimdisasm", libraryContext(member.id, root), root),
    "--no-libultra-syms", "--no-ique-syms", "--no-hardware-regs", "--no-default-banned", "--quiet"], root);
  writeFileSync(path, assembly); return path;
}
export function writeLibraryGraph(root = projectRoot()) {
  const members = libraryMembers(root);
  const entries = members.flatMap(member => member.functions.map(fn => {
    const target = libraryFunctionTarget(member, fn, root);
    return { name: target.key, symbol: target.symbol, container: target.owner.id, source: target.source,
      includeAsmPath: target.includeAsm.folder, assembly: target.assembly.function, verification: target.verification,
      vram: `symbol:${target.symbol}`, section: fn.section, sectionOffset: fn.offset, size: fn.size,
      inferredSize: fn.inferredSize, tier: 1, priority: 0, callerCount: 0, calls: [] as string[], calledBy: [] as string[], instructionCount: Math.ceil(fn.size / 4),
      decompiled: accepted(member, root), handwritten: false as const, dead: false };
  }));
  for (const member of members) for (const fn of member.functions) {
    const entry = entries.find(e => e.name === libraryTargetKey(member, fn.name))!;
    for (const r of member.object.relocations.filter(r => r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size && r.type === 4)) {
      const addend = (member.object.sections.get(r.section)!.data.readUInt32LE(r.offset) & 0x3ffffff) * 4;
      const target = resolveLibraryCall(member, r.reference, addend, members);
      if (target && target !== entry.name) entry.calls.push(target);
    }
    entry.calls = [...new Set(entry.calls)];
  }
  for (const entry of entries) for (const call of entry.calls) entries.find(e => e.name === call)!.calledBy.push(entry.name);
  for (const entry of entries) { entry.callerCount = entry.calledBy.length; entry.priority = entry.callerCount; }
  const graph = { targetKind: "relocatable-library", identityKind: "member-symbol", functions: entries,
    stats: { totalFunctions: entries.length, totalMembers: members.length, verifiedMembers: members.filter(m => accepted(m, root)).length } };
  mkdirSync(join(root, "build"), { recursive: true }); writeFileSync(join(root, "build/callGraph.json"), JSON.stringify(graph, null, 2) + "\n");
  return graph;
}
export function splitLibrary(root = projectRoot()): void {
  const project = loadLibraryProject(root)!;
  for (const member of libraryMembers(root)) {
    const assembly = disassembleLibraryMember(member, root);
    const folder = `build/libraries/nonmatchings/${member.id}`;
    const parts = libraryAssemblyParts(member, readFileSync(assembly, "utf8"));
    mkdirSync(join(root, folder), { recursive: true });
    for (const part of parts) writeFileSync(join(root, folder, `${part.symbol}.s`), part.text);
    const path = join(root, member.source);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `/* Original TU: ${member.input}[${member.ordinal}] ${member.member}\n * sha256: ${member.sha256}\n * One original member, one TU. Replace INCLUDE_ASM stubs with C; keep neighboring code/data.\n * Functions: ${member.functions.map(f => f.name).join(", ") || "none identified (data-only or unresolved code)"}\n */\n` +
        [...new Set([...project.headers.context, "include_asm.h"])].map(h => `#include "${h}"\n`).join("") + "\n" +
        parts.map(part => `INCLUDE_ASM("${folder}", ${part.symbol});\n`).join(""));
    }
  }
  mkdirSync(join(root, "build/libraries"), { recursive: true });
  writeFileSync(join(root, "build/libraries/inventory.json"), JSON.stringify(libraryInventory(root), null, 2) + "\n");
  writeLibraryGraph(root);
  console.log("Library members indexed; original objects/disassembly stay under build/libraries. Existing C untouched.");
}
export function libraryProgress(args: string[] = [], root = projectRoot()): void {
  const members = libraryMembers(root), rows = members.map(m => ({ id: m.id, input: m.input, member: m.member, ordinal: m.ordinal, source: m.source,
    functions: m.functions.map(f => libraryTargetKey(m, f.name)), codeBytes: [...m.object.sections.values()].filter(s => s.flags & 4).reduce((n, s) => n + s.size, 0), verified: accepted(m, root) }));
  const done = rows.filter(r => r.verified), report = { targetKind: "relocatable-library", scope: "fresh whole-member verification, not source presence or liveness",
    members: { verified: done.length, total: rows.length }, functions: { verified: done.reduce((n, r) => n + r.functions.length, 0), total: rows.reduce((n, r) => n + r.functions.length, 0) },
    codeBytes: { verified: done.reduce((n, r) => n + r.codeBytes, 0), total: rows.reduce((n, r) => n + r.codeBytes, 0) },
    unresolvedCodeMembers: rows.filter(r => r.codeBytes > 0 && !r.functions.length).map(r => r.id), rows };
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Verified library members: ${done.length}/${rows.length}; functions: ${report.functions.verified}/${report.functions.total}; code bytes: ${report.codeBytes.verified}/${report.codeBytes.total}`);
    console.log("All members remain in scope, including data-only and unresolved code. SDK names are not excluded; no assembly-origin claims inferred.");
    if (args.some(a => ["--list", "--remaining", "--done", "--markdown"].includes(a))) for (const r of rows.filter(r => args.includes("--remaining") ? !r.verified : args.includes("--done") ? r.verified : true))
      console.log(`${r.verified ? "MATCH" : "pending"}\t${r.id}\t${r.input}[${r.ordinal}] ${r.member}\t${r.source}`);
  }
}
/** --accepted is a loop environment guard, NOT whole-library completion.
 * A finalizer verifies the active member plus every previously accepted member;
 * npm check-all requires every configured member, including data-only objects. */
export function checkLibrary(args: string[], root = projectRoot()): void {
  const members = libraryMembers(root), ids = args.flatMap((a, i) => a === "--member" ? [args[i + 1]] : []);
  for (const id of ids) if (!members.some(m => m.id === id)) throw new Error(`Unknown library member ${id}`);
  const scoped = args.includes("--accepted") || ids.length > 0;
  const selected = scoped ? members.filter(m => ids.includes(m.id) || existsSync(acceptedPath(root, m))) : members;
  if (!scoped && !selected.length) throw new Error("No library members to verify");
  for (const member of selected) {
    const before = libraryBuildIdentity(member, root), artifacts = compileMember(member, undefined, root);
    const source = readFileSync(artifacts.source, "utf8"), guard = analyzeCSource(source), signatures = extractSignaturesFromSource(source);
    const findings = sourceConstructFindings(source, loadConfig(root), { name: member.id, container: member.id });
    const includesGeneratedContext = /#\s*\d+\s+"[^"]*build\/libraries\/context\//.test(readFileSync(artifacts.preprocessed, "utf8"));
    if (!guard.parses || guard.includeAsm.length || includesGeneratedContext || findings.length || member.functions.some(f => !signatures.some(s => s.name === f.name)))
      throw new Error(`${member.id}: complete clean-C member required (${findings.map(f => f.message).join("; ")})`);
    const comparison = compareRelocatableObjects(member.bytes, readFileSync(artifacts.object!));
    console.log(`${member.id}: ${renderLibraryComparison(comparison)}`);
    if (comparison.verdict !== "match") throw new Error(`${member.id}: whole-member verdict ${comparison.verdict}`);
    const identity = libraryBuildIdentity(member, root);
    if (before !== identity) throw new Error(`${member.id}: verification inputs changed during compile`);
    const path = acceptedPath(root, member); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...comparison, scope: "whole-member", identity, originalHash: member.sha256, source: member.source }, null, 2) + "\n");
  }
  console.log(scoped ? `Verified ${selected.length} active/previously accepted member(s); ${members.length - selected.length} backlog member(s) not verified.` : `All ${selected.length} configured library members verified.`);
}
export async function prepareLibraryFunction(name: string, options: { root?: string; signal?: AbortSignal; alternative?: boolean; contextFile?: string } = {}) {
  const root = options.root ?? projectRoot(), { member, fn, key } = requireLibraryFunction(name, root), p = loadLibraryProject(root)!;
  const target = libraryFunctionTarget(member, fn, root);
  options.signal?.throwIfAborted();
  const assembly = disassembleLibraryMember(member, root);
  const destination = join(root, member.source), source = existsSync(destination) ? readFileSync(destination, "utf8") : "";
  const existing = !!source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*#include[^\n]*$/gm, "").replace(/^\s*INCLUDE_ASM\([^)]*\);\s*$/gm, "").trim();
  const latest = join(root, "build/preparation", key, "latest-library.json");
  let retained: PreparationPacket["primary"] = null;
  if (!existing && !options.alternative) {
    try {
      const previous = JSON.parse(readFileSync(latest, "utf8")) as { draft: string };
      const text = readFileSync(resolve(root, previous.draft), "utf8");
      retained = { origin: "m2c", path: previous.draft, text, sha256: digest(text), declarationsRequired: [] };
    } catch { /* No prior draft. Failed/empty generation never publishes this pointer. */ }
  }
  const directory = join(root, "build/preparation", key, `${Date.now()}-${process.pid}`); mkdirSync(directory, { recursive: true });
  const paths = [...memberInputPaths(member, root), member.assembly, `build/libraries/nonmatchings/${member.id}`,
    target.context.types, target.context.functions,
    ...(options.contextFile ? [options.contextFile] : [])];
  const inputs: Record<string, string> = {}, memberships: Record<string, string[]> = {};
  for (const path of paths) {
    const absolute = resolve(root, path), key = relative(root, absolute);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      const files = filesUnder(absolute).filter(f => !f.includes("__pycache__") && !f.endsWith(".pyc"));
      memberships[key] = files.map(f => relative(root, f)).sort();
      for (const file of files) inputs[relative(root, file)] = hashFile(file);
    } else inputs[key] = hashFile(absolute);
  }
  const context = join(directory, "context.c");
  writeFileSync(context, p.headers.context.map(h => `#include "${h}"`).join("\n") + "\n" + (options.contextFile ? readFileSync(resolve(root, options.contextFile), "utf8") : ""));
  const flagContext = target.flags, flags = configuredFlags("cc1", flagContext, root).concat(loadFlagOverrides(root).get(member.id) ?? []);
  const packet: PreparationPacket = { schemaVersion: 1, preparationState: "running", identity: { compatibility: COMPONENT_CONTRACTS.preparation, functionName: key, symbol: fn.name, targetKind: "relocatable-library", container: member.id,
    destination: target.source, assembly: existsSync(join(root, target.assembly.function)) ? target.assembly.function : target.assembly.translationUnit,
    data: [member.original], inputs, memberships, fingerprint: digest(JSON.stringify({ inputs, memberships })), tools: { compilation: compilationIdentity(root, target.flags, member.id), m2c: { compatibility: "patched-m2c-v1", source: prepareM2c(root).identity.sha256, flags: configuredFlags("m2c", target.flags, root) }, context: COMPONENT_CONTRACTS.context }, flags },
    verification: target.verification,
    primary: existing && !options.alternative ? { origin: "existing-attempt", path: member.source, sha256: digest(source), text: source, declarationsRequired: [] } : retained,
    context: { index: emptyDeclarationIndex(), projection: relative(root, context), excluded: [], unknown: [], headers: p.headers.context },
    generation: { status: "not-attempted" }, compilation: { status: "not-attempted", commands: [], diagnostics: "" }, comparison: { status: "not-available" },
    integration: { state: existing && !options.alternative ? "live" : "staged", changes: [member.source], blockers: [], destinationHash: hashFile(destination) },
    discovery: { unknowns: [], report: { scope: "whole-member", member: member.id, input: member.input, ordinal: member.ordinal, originalHash: member.sha256, functions: member.functions }, priorExperiments: [], preflight: [] }, finalization: { status: "not-attempted" } };
  try {
    if (!packet.primary) {
      const m2c = prepareM2c(root);
      // Source/patch content identity lives in the component witness, not an installation-path input.
      const cpp = await recordedCommand(configuredTool("cpp", root), [...configuredFlags("cpp", flagContext, root), context, "-o", join(directory, "context.i")], root, directory, "context-cpp", options.signal);
      packet.discovery.preflight.push(cpp);
      if (cpp.status !== 0) throw new Error(commandText(cpp));
      // Decompile ALL member functions into one draft, retaining its TU boundary.
      const index = emptyDeclarationIndex();
      indexDeclarations(index, readFileSync(join(directory, "context.i"), "utf8"), relative(root, context), member.id, "public-header");
      for (const path of [target.context.types, target.context.functions]) if (existsSync(join(root, path)))
        indexDeclarations(index, readFileSync(join(root, path), "utf8"), path, member.id, "source-local");
      const roots = [...member.functions.map(fn => fn.name), ...member.object.symbols.filter(s => s.binding !== 0 && s.name && !s.name.endsWith(".NON_MATCHING")).map(s => s.name)];
      const projection = projectDeclarations(index, roots, member.id), projectedPath = join(directory, "m2c.ctx");
      writeFileSync(projectedPath, projection.text);
      packet.context = { ...packet.context, index, projection: relative(root, projectedPath), excluded: projection.excluded, unknown: projection.unknown };
      const command = await recordedCommand(configuredTool("python", root), [m2c.script, ...configuredFlags("m2c", flagContext, root), "--no-cache", "--context", projectedPath,
        assembly], root, directory, "m2c", options.signal);
      packet.generation.command = command; packet.generation.raw = relative(root, command.stdout); packet.generation.rawHash = hashFile(command.stdout);
      const raw = readFileSync(command.stdout, "utf8");
      packet.generation.status = command.status === 0 && !raw.includes("Decompilation failure:") ? "generated" : "failed";
      if (packet.generation.status !== "generated") throw new Error(commandText(command));
      const text = p.headers.context.map(h => `#include "${h}"`).join("\n") + "\n\n" + raw;
      const draft = join(directory, "draft.c"); writeFileSync(draft, text);
      packet.primary = { origin: "m2c", path: relative(root, draft), sha256: digest(text), text,
        declarationsRequired: projection.selected.filter(d => d.kind === "type" && d.visibility === "source-local") }; packet.generation.draftHash = digest(text);
    }
    const guard = analyzeCSource(packet.primary.text);
    if (!guard.parses || guard.includeAsm.length) packet.integration.blockers.push("Candidate must be clean C for the entire member");
    options.signal?.throwIfAborted();
    const artifacts = await compileSourceAsync(packet.primary.path, join(directory, "compile"), member.id,
      { assemble: true, containerKind: "library", containerId: member.id, ...(options.signal ? { signal: options.signal } : {}) });
    const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
    if (rejection) throw new Error(`Invalid C: ${rejection}`);
    const comparison = compareLibraryCandidate(member, artifacts);
    const report = join(directory, "comparison.json");
    writeFileSync(report, JSON.stringify({ target: key, scope: "whole-member", ...comparison }, null, 2) + "\n");
    packet.compilation = { ...packet.compilation, status: "succeeded", diagnostics: artifacts.diagnostics,
      preprocessed: { path: relative(root, artifacts.preprocessed), sha256: hashFile(artifacts.preprocessed) },
      assembly: { path: relative(root, artifacts.assembly), sha256: hashFile(artifacts.assembly) }, object: { path: relative(root, artifacts.object!), sha256: hashFile(artifacts.object!) } };
    packet.comparison = { status: comparison.verdict === "match" ? "exact" : comparison.verdict === "mismatch" ? "mismatching" : "undetermined", report: relative(root, report) };
    packet.integration.blockers.push(...sourceConstructFindings(packet.primary.text, loadConfig(root), { name: member.id, container: member.id }).map(f => f.message));
    if (member.functions.length !== 1) packet.integration.blockers.push("Multi-function TU: integrate explicitly, preserving all neighboring functions and globals; automatic single-stub staging disabled");
  } catch (error) {
    packet.integration.blockers.push(String(error)); packet.compilation.diagnostics += "\n" + String(error);
    if (packet.primary) packet.compilation.status = "failed";
  }
  // Preserve the same diagnostic handoff fields as the image adapter. These
  // tools already consume normalized targets; no format-specific agent steps.
  for (const [script, label] of [["scanReadBeforeDef.ts", "read-before-definition"], ["triage.ts", "triage"]]) {
    try {
      const args = [key, "--json", ...(label === "triage" && packet.primary ? ["--src", packet.primary.path] : [])];
      const result = await recordedCommand(process.execPath, currentScriptArgs(`tools/agent/${script}`, args), root, directory, label!, options.signal);
      packet.discovery.preflight.push(result);
      if (result.status !== 0) throw new Error(commandText(result));
      const report = JSON.parse(readFileSync(result.stdout, "utf8"));
      if (label === "read-before-definition") packet.discovery.readBeforeDefinition = report;
      else { packet.discovery.macroIdentity = report.macroIdentity; packet.discovery.report = { ...packet.discovery.report as object, findings: report.findings }; }
    } catch (error) {
      packet.discovery.unknowns.push({ subject: label!, strength: "unknown", constraints: [], evidence: [member.assembly],
        missing: String(error), attempted: `shared ${script}`, bound: "selected function/TU", stoppedBecause: "diagnostic failed", inspectNext: [relative(root, directory)] });
    }
  }
  if (fn.inferredSize) packet.discovery.unknowns.push({ subject: key, strength: "conditional", constraints: [], evidence: [member.assembly],
    missing: "NOTYPE/size-zero symbol extent is inferred. Function-local diagnostics retain that uncertainty; only the whole-member oracle can certify this TU.",
    attempted: "symbol/section bounds and shared function diagnostics", bound: "one original member/TU", stoppedBecause: "original size annotation absent", inspectNext: [member.original] });
  packet.preparationState = "complete";
  packet.identity.fingerprint = digest(JSON.stringify({ inputs, memberships }));
  if (!options.alternative && packet.primary?.origin === "m2c")
    writeFileSync(latest, JSON.stringify({ draft: packet.primary.path }) + "\n");
  const path = relative(root, join(directory, "packet.json"));
  writeFileSync(join(root, path), JSON.stringify(packet, null, 2) + "\n");
  writeFileSync(join(directory, "handoff.md"), packetOpening(packet, path)); writeFileSync(join(directory, "evidence.md"), packetEvidence(packet)); writeFileSync(join(directory, "diagnostics.txt"), packet.compilation.diagnostics);
  return { packet, path };
}
export function runLibraryTask(task: string, args: string[] = []): void {
  if (["inventory", "identify"].includes(task)) { console.log(JSON.stringify(libraryInventory(), null, 2)); return; }
  if (["split", "split-all", "disassemble"].includes(task)) { splitLibrary(); return; }
  if (task === "graph") { console.log(JSON.stringify(writeLibraryGraph(), null, 2)); return; }
  if (task === "progress") { libraryProgress(args); return; }
  if (["check", "check-all"].includes(task)) { checkLibrary(args); return; }
  if (task === "build") {
    const members = libraryMembers(), pending = members.filter(m => existsSync(join(projectRoot(), m.source)));
    for (const member of pending) compileMember(member);
    console.log(`Compiled ${pending.length}/${members.length} reconstructed TU(s); this is not verification.`); return;
  }
  throw new Error(`${task} is not supported for a relocatable-library target; see docs/library-targets.md`);
}
