import { COMPONENT_CONTRACTS, compilationIdentity, stableHash } from "../lib/cacheIdentity.js";
import { currentScriptArgs } from "../lib/installedScripts.js";
import { projectRoot } from "../lib/runtimeContext.js";
/** Library-mode bridge for npm and the existing Pi preparation/diff/gate loop.
 * Iterations compile the owning TU; acceptance is the entire original member.
 * No original object is ever substituted for missing reconstructed C. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { configuredCompilerAnalysis, configuredFlags, configuredTool, toolchainExecutables } from "../lib/toolchain.js";
import { libraryContext, loadLibraryProject, libraryInputFiles } from "../lib/project.js";
import { libraryInventory, libraryMembers, libraryTargetKey, materializeOriginal, requireLibraryFunction, resolveLibraryCall, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { compareRelocatableObjects, readRelocatableObject, type ObjectComparison } from "../lib/relocatableObject.js";
import { libraryDisassemblySymbols, validateLibraryDisassembly } from "../lib/libraryDisassembly.js";
import { libraryAssemblyParts, librarySourceScaffold } from "../lib/libraryAssembly.js";
import { migrateLibrarySources, writeLibraryTu } from "./librarySources.js";
import { isDirectoryTu, inspectLibraryPart, libraryFunctionSource, librarySourceFiles, libraryTuStatus } from "../lib/libraryTranslationUnit.js";
import { classifyLibraryCode } from "./libraryCodeClass.js";
import { biosSyscallCandidate } from "./biosSyscall.js";
import { biosTailJumpCandidate } from "./biosTailJump.js";
import { libraryFunctionTarget } from "../lib/targetAdapter.js";
import { digest, fileDigest, filesUnder, snapshot, withContentMemo } from "../lib/contentCache.js";
import { recordedCommand, commandText } from "../lib/recordedCommand.js";
import { compileSource, compileSourceAsync, configuredToolchainIdentity, loadFlagOverrides, preprocessOnly, rejectionFromDiagnostics, runTool, sourceDependencyFiles } from "./decompToolchain.js";
import { extractSignaturesFromSource } from "./sdkTypes.js";
import { analyzeCSource } from "./cSourceGuard.js";
import { emptyDeclarationIndex, indexDeclarations, projectDeclarations } from "./declarationContext.js";
import { prepareM2c } from "../build/prepareM2c.js";
import { packetOpening, packetEvidence, type PreparationPacket } from "./campaign/packet.js";
import { sourceConstructFindings } from "../../.pi/extensions/shared/source-policy.js";
import { loadConfig } from "../../.pi/extensions/shared/config.js";
const hashFile = (path: string) => existsSync(path) ? digest(readFileSync(path)) : "absent";
const acceptedPath = (root: string, member: LibraryMember) => join(root, "build/libraries/verified", `${member.id}.json`);
function backlogInputs(member: LibraryMember, root: string): string[] {
  if (!isDirectoryTu(member) || !existsSync(join(root, member.source))) return [];
  return libraryTuStatus(member, root)!.filter(p => p.stub).map(p => `build/libraries/nonmatchings/${member.id}/${p.symbol}.s`);
}
function memberInputPaths(member: LibraryMember, root: string, inputs?: string[]): string[] {
  const p = loadLibraryProject(root)!;
  const context = libraryContext(member.id, root);
  const cpp = configuredFlags("cpp", context, root);
  const includeDirs = cpp.flatMap((f, i) => f === "-I" ? [cpp[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
  return ["project.json", ...backlogInputs(member, root), ...(existsSync(join(root, member.source)) ? librarySourceFiles(member, root) : [member.source]), ...(inputs ?? libraryInputFiles(p, root).map(i => i.path)),
    ...includeDirs, ...p.headers.reference, ...p.headers.owned,
    ...(existsSync(join(root, member.source)) ? sourceDependencyFiles(member.source, context, root) : [])];
}
/** The same active/previously accepted set used by the per-function gate. */
export function libraryVerificationMembers(ids: string[], root = projectRoot(), members = libraryMembers(root)): LibraryMember[] {
  for (const id of ids) if (!members.some(m => m.id === id)) throw new Error(`Unknown library member ${id}`);
  return members.filter(m => {
    if (ids.includes(m.id)) return true;
    try { const record = JSON.parse(readFileSync(acceptedPath(root, m), "utf8"));
      // Byte-checked assembly backlog is not an accepted C regression target.
      return record.reconstructed !== false || record.completedFunctions?.length > 0;
    } catch { return false; }
  });
}
/** Snapshot shared targets/headers once, not once per member. Uncompiled source
 * edits still invalidate finalization; only the checked TUs need CPP dependencies. */
export function libraryWorkspaceIdentity(members: LibraryMember[], root = projectRoot()): string {
  return withContentMemo(() => {
    const inputs = libraryInputFiles(loadLibraryProject(root)!, root).map(i => i.path);
    const paths = ["src", "project.json", "toolchain.json", "configs/flag_overrides.mk", ...inputs,
      ...members.flatMap(m => memberInputPaths(m, root, []))];
    const identities = members.map(m => {
      if (fileDigest(resolve(root, m.input)) !== m.inputHash) throw new Error(`Target input changed while measuring ${m.id}; rerun inventory`);
      return [m.id, m.sha256, m.inputHash, compilationIdentity(root, libraryContext(m.id, root), m.id)];
    });
    return digest(JSON.stringify({ members: identities,
      inputs: snapshot(root, paths, f => !f.endsWith(".test.ts") && !f.includes("__pycache__")) }));
  });
}
export function libraryBuildIdentity(member: LibraryMember, root = projectRoot()): string {
  if (hashFile(resolve(root, member.input)) !== member.inputHash) throw new Error(`Target input changed while measuring ${member.id}; rerun inventory`);
  return digest(JSON.stringify({ target: member.sha256, input: member.inputHash,
    tools: compilationIdentity(root, libraryContext(member.id, root), member.id),
    inputs: snapshot(root, memberInputPaths(member, root), f => !f.endsWith(".test.ts") && !f.includes("__pycache__")) }));
}
/** Versioned shared/owner fingerprints: hash the common catalogue once, not
 * once per TU. The final guard re-reads all observed inputs and tools. */
export function libraryBuildIdentities(root = projectRoot()) {
  const project = loadLibraryProject(root)!;
  const commonPaths = ["project.json", ...libraryInputFiles(project, root).map(i => i.path), ...project.headers.reference, ...project.headers.owned];
  const filter = (f: string) => !f.endsWith(".test.ts") && !f.includes("__pycache__");
  const common = snapshot(root, commonPaths, filter), commonHash = digest(JSON.stringify(common));
  const guardPaths = ["src", "toolchain.json", "configs/flag_overrides.mk"];
  const expected = { ...common, ...snapshot(root, guardPaths, filter) };
  const tools = JSON.stringify(compilationIdentity(root));
  const includes = new Map<string, string>(), includeInputs = new Map<string, Record<string, string>>();
  const locals = new Map<string, Record<string, string>>();
  const observedPaths = new Set([...commonPaths, ...guardPaths]);
  const identity = (member: LibraryMember): string => {
    if (fileDigest(resolve(root, member.input)) !== member.inputHash) throw new Error(`Target input changed while measuring ${member.id}; rerun inventory`);
    const context = libraryContext(member.id, root), cpp = configuredFlags("cpp", context, root);
    const dirs = cpp.flatMap((f, i) => f === "-I" ? [cpp[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
    const key = JSON.stringify(dirs);
    if (!includes.has(key)) {
      const input = snapshot(root, dirs, filter);
      includes.set(key, digest(JSON.stringify(input))); includeInputs.set(key, input);
      for (const [path, hash] of Object.entries(input)) {
        if (expected[path] !== undefined && expected[path] !== hash) throw new Error(`Library input changed during batch: ${path}`);
        expected[path] = hash;
      }
      dirs.forEach(p => observedPaths.add(p));
    }
    const paths = [member.source, ...backlogInputs(member, root), ...(existsSync(join(root, member.source)) ? sourceDependencyFiles(member.source, context, root) : [])];
    const local = snapshot(root, paths, filter); locals.set(member.id, local);
    for (const [path, hash] of Object.entries(local)) {
      if (expected[path] !== undefined && expected[path] !== hash) throw new Error(`Library input changed during batch: ${path}`);
      expected[path] = hash;
    }
    paths.forEach(p => observedPaths.add(p));
    return digest(JSON.stringify({ version: 2, target: member.sha256, input: member.inputHash, common: commonHash,
      includes: includes.get(key), tools: compilationIdentity(root, context, member.id), local }));
  };
  const assertUnchanged = () => {
    const after = snapshot(root, [...observedPaths], filter);
    const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
    if (JSON.stringify(after) !== JSON.stringify(sorted) || tools !== JSON.stringify(compilationIdentity(root)))
      throw new Error("Library batch inputs changed; rerun verification");
  };
  const legacyIdentity = (member: LibraryMember): string => {
    identity(member);
    const cpp = configuredFlags("cpp", libraryContext(member.id, root), root);
    const dirs = cpp.flatMap((f, i) => f === "-I" ? [cpp[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
    const input = { ...common, ...includeInputs.get(JSON.stringify(dirs)), ...locals.get(member.id) };
    return digest(JSON.stringify({ target: member.sha256, input: member.inputHash,
      tools: compilationIdentity(root, libraryContext(member.id, root), member.id),
      inputs: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) }));
  };
  return { identity, legacyIdentity, assertUnchanged };
}
export function isLibraryMemberVerified(member: LibraryMember, root = projectRoot()): boolean {
  return verifiedLibraryMembers([member], root).get(member.id)!;
}
export function verifiedLibraryMembers(members: LibraryMember[], root = projectRoot()): Map<string, boolean> {
  return withContentMemo(() => {
    const batch = libraryBuildIdentities(root), upgrades: Array<{ member: LibraryMember; record: Record<string, unknown> }> = [];
    const verified = new Map(members.map(member => {
      try {
        const record = JSON.parse(readFileSync(acceptedPath(root, member), "utf8"));
        const match = record.verdict === "match" && record.identity === (record.identityVersion === 2 ? batch.identity(member) : batch.legacyIdentity(member));
        if (match && record.identityVersion !== 2) upgrades.push({ member, record: { ...record, identityVersion: 2, identity: batch.identity(member) } });
        return [member.id, match] as const;
      } catch { return [member.id, false] as const; }
    }));
    batch.assertUnchanged();
    // Upgrade only independently revalidated legacy fingerprints. No verdict
    // is invented, and no input change can pass the batch guard.
    for (const { member, record } of upgrades) writeFileSync(acceptedPath(root, member), JSON.stringify(record, null, 2) + "\n");
    return verified;
  });
}

function compileMember(member: LibraryMember, source = member.source, root = projectRoot(), key = member.id) {
  const artifacts = compileSource(source, `build/libraries/candidates/${member.id}/${randomUUID()}`, key, { assemble: true, containerKind: "library", containerId: member.id });
  const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
  if (rejection) throw new Error(`Invalid C: ${rejection}`);
  return artifacts;
}
export function measureLibraryFunction(name: string, source?: string) {
  const target = requireLibraryFunction(name), artifacts = compileMember(target.member, source ?? libraryFunctionSource(target.member, target.fn.name), projectRoot(), target.key);
  const comparison = compareLibraryCandidate(target.member, artifacts, target.fn.name);
  const report = join(artifacts.outputDir, "comparison.json");
  writeFileSync(report, JSON.stringify({ target: target.key, scope: "whole-member", memberHash: target.member.sha256, ...comparison }, null, 2) + "\n");
  return { ...target, artifacts, comparison, report };
}
function compareLibraryCandidate(member: LibraryMember, artifacts: ReturnType<typeof compileSource>, symbol?: string): ObjectComparison {
  const object = readFileSync(artifacts.object!), comparison = compareRelocatableObjects(member.bytes, object);
  if (isDirectoryTu(member)) {
    const status = libraryTuStatus(member, projectRoot(), symbol ? { symbol, source: artifacts.source } : undefined)!;
    const selectedStub = status.some(p => p.symbol === symbol && p.stub) || (symbol && readRelocatableObject(object).symbols.some(s => s.name === `${symbol}.NON_MATCHING`));
    return selectedStub ? { ...comparison, verdict: "stub", differences: ["Selected function is still an assembly backlog stub", ...comparison.differences] } : comparison;
  }
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
  const symbols = join(dirname(path), "function-bounds.txt");
  writeFileSync(symbols, libraryDisassemblySymbols(member));
  const flags = configuredFlags("spimdisasm", libraryContext(member.id, root), root);
  if (flags.some(f => f === "--symbol-addrs" || f.startsWith("--symbol-addrs="))) throw new Error("Library disassembly owns its section-relative symbol bounds; remove --symbol-addrs from configured flags");
  const assembly = runTool(configuredTool("spimdisasm", root), ["elfObjDisasm", original, "-", ...flags,
    "--symbol-addrs", symbols, "--no-libultra-syms", "--no-ique-syms", "--no-hardware-regs", "--no-default-banned", "--no-cop0-named-registers", "--quiet"], root);
  validateLibraryDisassembly(member, assembly);
  writeFileSync(path, assembly); return path;
}
export function writeLibraryGraph(root = projectRoot()) {
  const members = libraryMembers(root);
  return withLibraryMetadata(() => writeLibraryGraphScoped(members, root), members, root);
}
function writeLibraryGraphScoped(members: LibraryMember[], root: string) {
  const verified = verifiedLibraryMembers(members, root);
  const statuses = new Map(members.filter(m => isDirectoryTu(m) && existsSync(join(root, m.source))).map(m => [m.id, new Map(libraryTuStatus(m, root)!.map(p => [p.symbol, p.stub]))]));
  const entries = members.flatMap(member => member.functions.map(fn => {
    const target = libraryFunctionTarget(member, fn, root);
    const assemblyClass = classifyLibraryCode(member.object, fn);
    const syscall = assemblyClass ? biosSyscallCandidate(member, fn, root) ?? biosTailJumpCandidate(member, fn, root) : undefined;
    return { name: target.key, symbol: target.symbol, container: target.owner.id, source: target.source,
      includeAsmPath: target.includeAsm.folder, assembly: target.assembly.function, verification: target.verification,
      vram: `symbol:${target.symbol}`, section: fn.section, sectionOffset: fn.offset, size: fn.size,
      inferredSize: fn.inferredSize, tier: 1, priority: 0, callerCount: 0, calls: [] as string[], calledBy: [] as string[], instructionCount: Math.ceil(fn.size / 4),
      decompiled: verified.get(member.id)! && (!isDirectoryTu(member) || statuses.get(member.id)?.get(fn.name) === false), handwritten: assemblyClass && !syscall ? "asm" as const : false as const, dead: false,
      ...(assemblyClass ? { assemblyClass } : {}), ...(syscall ? { platformMacro: syscall.evidence } : {}) };
  }));
  const byName = new Map(entries.map(e => [e.name, e]));
  for (const member of members) for (const fn of member.functions) {
    const entry = byName.get(libraryTargetKey(member, fn.name))!;
    for (const r of member.object.relocations.filter(r => r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size && r.type === 4)) {
      const addend = (member.object.sections.get(r.section)!.data.readUInt32LE(r.offset) & 0x3ffffff) * 4;
      const target = resolveLibraryCall(member, r.reference, addend, members);
      if (target && target !== entry.name) entry.calls.push(target);
    }
    entry.calls = [...new Set(entry.calls)];
  }
  for (const entry of entries) for (const call of entry.calls) byName.get(call)!.calledBy.push(entry.name);
  for (const entry of entries) { entry.callerCount = entry.calledBy.length; entry.priority = entry.callerCount; }
  const graph = { targetKind: "relocatable-library", identityKind: "member-symbol", functions: entries,
    stats: { totalFunctions: entries.length, totalMembers: members.length, verifiedMembers: [...verified.values()].filter(Boolean).length,
      assemblyOnlyFunctions: entries.filter(entry => entry.handwritten === "asm").length } };
  mkdirSync(join(root, "build"), { recursive: true }); writeFileSync(join(root, "build/callGraph.json"), JSON.stringify(graph, null, 2) + "\n");
  return graph;
}
export function splitLibrary(root = projectRoot()): void {
  const project = loadLibraryProject(root)!, members = libraryMembers(root);
  // Validate the whole batch before changing live manifests or publishing new
  // backlog fragments. Failed disassembly must not leave a half-migrated TU.
  const staged = members.map(member => {
    const assembly = disassembleLibraryMember(member, root);
    return { member, parts: libraryAssemblyParts(member, readFileSync(assembly, "utf8")) };
  });
  const moves = migrateLibrarySources(members, project, root);
  if (moves.length) console.log(`Migrated ${moves.length} library sources to their derived paths; function/declaration order preserved.`);
  for (const { member, parts } of staged) {
    const folder = `build/libraries/nonmatchings/${member.id}`;
    mkdirSync(join(root, folder), { recursive: true });
    for (const part of parts) writeFileSync(join(root, folder, `${part.symbol}.s`), part.text);
    const path = join(root, member.source);
    if (!existsSync(path)) {
      if (isDirectoryTu(member)) writeLibraryTu(member, librarySourceScaffold(member, project.headers.context, parts), root);
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, librarySourceScaffold(member, project.headers.context, parts)); }
    }
  }
  mkdirSync(join(root, "build/libraries"), { recursive: true });
  writeFileSync(join(root, "build/libraries/inventory.json"), JSON.stringify(libraryInventory(root), null, 2) + "\n");
  writeLibraryGraph(root);
  console.log("Library members indexed; original objects/disassembly stay under build/libraries. Existing function bodies preserved.");
}
export function libraryProgress(args: string[] = [], root = projectRoot()): void {
  const members = libraryMembers(root), verified = verifiedLibraryMembers(members, root);
  const rows = members.map(m => ({ id: m.id, input: m.input, member: m.member, ordinal: m.ordinal, source: m.source,
    functions: m.functions.map(f => libraryTargetKey(m, f.name)), completedFunctions: verified.get(m.id) ? (isDirectoryTu(m) ? libraryTuStatus(m, root)!.filter(p => p.symbol && p.symbol !== "__library_member_data" && !p.stub).map(p => libraryTargetKey(m, p.symbol!)) : m.functions.map(f => libraryTargetKey(m, f.name))) : [], complete: verified.get(m.id)! && (!isDirectoryTu(m) || libraryTuStatus(m, root)!.every(p => !p.stub)), codeBytes: [...m.object.sections.values()].filter(s => s.flags & 4).reduce((n, s) => n + s.size, 0), verified: verified.get(m.id)! }));
  const done = rows.filter(r => r.complete), report = { targetKind: "relocatable-library", scope: "fresh whole-member bytes; only clean-C function files count as decompiled",
    members: { verified: rows.filter(r => r.verified).length, reconstructed: done.length, total: rows.length }, functions: { verified: rows.reduce((n, r) => n + r.completedFunctions.length, 0), total: rows.reduce((n, r) => n + r.functions.length, 0) },
    codeBytes: { verified: done.reduce((n, r) => n + r.codeBytes, 0), total: rows.reduce((n, r) => n + r.codeBytes, 0) },
    unresolvedCodeMembers: rows.filter(r => r.codeBytes > 0 && !r.functions.length).map(r => r.id), rows };
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Reconstructed library members: ${done.length}/${rows.length}; functions: ${report.functions.verified}/${report.functions.total}; code bytes: ${report.codeBytes.verified}/${report.codeBytes.total}`);
    console.log("All members remain in scope, including data-only and unresolved code. SDK names are not excluded; no assembly-origin claims inferred.");
    if (args.some(a => ["--list", "--remaining", "--done", "--markdown"].includes(a))) for (const r of rows.filter(r => args.includes("--remaining") ? !r.complete : args.includes("--done") ? r.complete : true))
      console.log(`${r.complete ? "MATCH" : "pending"}\t${r.id}\t${r.input}[${r.ordinal}] ${r.member}\t${r.source}`);
  }
}
/** --accepted is a loop environment guard, NOT whole-library completion.
 * A finalizer verifies the active member plus every previously accepted member;
 * npm check-all requires every configured member, including data-only objects. */
export function checkLibrary(args: string[], root = projectRoot()): void {
  const members = libraryMembers(root), ids = args.flatMap((a, i) => a === "--member" ? [args[i + 1] ?? ""] : []);
  const scoped = args.includes("--accepted") || ids.length > 0;
  const selected = scoped ? libraryVerificationMembers(ids, root, members) : members;
  if (!scoped && !selected.length) throw new Error("No library members to verify");
  const batch = libraryBuildIdentities(root), records: Array<{ member: LibraryMember; comparison: ObjectComparison; identity: string }> = [];
  withLibraryMetadata(() => { for (const member of selected) {
    const identity = batch.identity(member), artifacts = compileMember(member, undefined, root);
    const source = isDirectoryTu(member) ? "" : readFileSync(artifacts.source, "utf8"), guard = analyzeCSource(source), signatures = extractSignaturesFromSource(source);
    const findings = isDirectoryTu(member) ? libraryTuStatus(member, root)!.flatMap(part => part.stub ? [] : sourceConstructFindings(readFileSync(part.source, "utf8"), loadConfig(root), { name: part.symbol ? libraryTargetKey(member, part.symbol) : member.id, container: member.id })) : sourceConstructFindings(source, loadConfig(root), { name: member.id, container: member.id });
    const includesGeneratedContext = /#\s*\d+\s+"[^"]*build\/libraries\/context\//.test(readFileSync(artifacts.preprocessed, "utf8"));
    if (!guard.parses || guard.includeAsm.length || includesGeneratedContext || findings.length || (!isDirectoryTu(member) && member.functions.some(f => !signatures.some(s => s.name === f.name))))
      throw new Error(`${member.id}: complete clean-C member required (${findings.map(f => f.message).join("; ")})`);
    const comparison = compareRelocatableObjects(member.bytes, readFileSync(artifacts.object!));
    console.log(`${member.id}: ${renderLibraryComparison(comparison)}`);
    if (comparison.verdict !== "match") throw new Error(`${member.id}: whole-member verdict ${comparison.verdict}`);
    records.push({ member, comparison, identity });
  } }, members, root);
  batch.assertUnchanged();
  for (const { member, comparison, identity } of records) {
    const path = acceptedPath(root, member); mkdirSync(dirname(path), { recursive: true });
    const status = isDirectoryTu(member) ? libraryTuStatus(member, root) : undefined;
    writeFileSync(path, JSON.stringify({ ...comparison, scope: "whole-member", identityVersion: 2, identity, originalHash: member.sha256, source: member.source,
      reconstructed: status ? status.every(p => !p.stub) : true,
      completedFunctions: status ? status.filter(p => p.symbol && p.symbol !== "__library_member_data" && !p.stub).map(p => p.symbol) : member.functions.map(f => f.name) }, null, 2) + "\n");
  }
  console.log(scoped ? `Verified ${selected.length} active/previously accepted member(s); ${members.length - selected.length} backlog member(s) not verified.` : `All ${selected.length} configured library members are byte-exact; explicit assembly backlog is not decompiled C.`);
}
export async function prepareLibraryFunction(name: string, options: { root?: string; signal?: AbortSignal; alternative?: boolean; contextFile?: string } = {}) {
  const root = options.root ?? projectRoot(), { member, fn, key } = requireLibraryFunction(name, root), p = loadLibraryProject(root)!;
  const target = libraryFunctionTarget(member, fn, root);
  options.signal?.throwIfAborted();
  const assembly = disassembleLibraryMember(member, root);
  const destination = join(root, target.source), source = existsSync(destination) ? readFileSync(destination, "utf8") : "";
  const existing = !!source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*#include[^\n]*$/gm, "").replace(/^\s*INCLUDE_ASM\([^)]*\);\s*$/gm, "").trim();
  const latest = join(root, "build/preparation", key, "latest-library.json");
  const boundaryIdentity = stableHash(member.functions.map(f => [f.name, f.section, f.offset, f.size]));
  const syscall = biosSyscallCandidate(member, fn, root) ?? biosTailJumpCandidate(member, fn, root);
  let retained: PreparationPacket["primary"] = null;
  if (!existing && !options.alternative && !syscall) {
    try {
      const previous = JSON.parse(readFileSync(latest, "utf8")) as { draft: string; destination?: string; generationContract?: string; boundaryIdentity?: string };
      const text = readFileSync(resolve(root, previous.draft), "utf8");
      if (isDirectoryTu(member)) {
        if (previous.destination !== target.source || previous.generationContract !== "directory-tu-selected-related-v3" || previous.boundaryIdentity !== boundaryIdentity || inspectLibraryPart(text, { path: `${fn.name}.c`, symbol: fn.name }).stub) throw new Error("Prior draft belongs to a different source boundary");
      }
      retained = { origin: "m2c", path: previous.draft, text, sha256: digest(text), declarationsRequired: [] };
    } catch { /* No prior draft. Failed/empty generation never publishes this pointer. */ }
  }
  const directory = join(root, "build/preparation", key, `${Date.now()}-${process.pid}`); mkdirSync(directory, { recursive: true });
  const paths = [...memberInputPaths(member, root), member.assembly, `build/libraries/nonmatchings/${member.id}`,
    target.context.types, target.context.functions,
    ...(options.contextFile ? [options.contextFile] : []),
    ...(syscall ? [syscall.evidence.header, syscall.evidence.signatureHeader] : [])];
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
  const packet: PreparationPacket = { schemaVersion: 1, preparationState: "running", preparationScope: isDirectoryTu(member) ? "function" : "translation-unit", identity: { compatibility: COMPONENT_CONTRACTS.preparation, functionName: key, symbol: fn.name, targetKind: "relocatable-library", container: member.id,
    destination: target.source, assembly: existsSync(join(root, target.assembly.function)) ? target.assembly.function : target.assembly.translationUnit,
    data: [member.original], inputs, memberships, fingerprint: digest(JSON.stringify({ inputs, memberships })), tools: { compilation: compilationIdentity(root, target.flags, member.id), m2c: { compatibility: "patched-m2c-v1", source: prepareM2c(root).identity.sha256, flags: configuredFlags("m2c", target.flags, root) }, context: COMPONENT_CONTRACTS.context }, flags },
    verification: target.verification,
    primary: existing && !options.alternative ? { origin: "existing-attempt", path: target.source, sha256: digest(source), text: source, declarationsRequired: [] } : retained,
    context: { index: emptyDeclarationIndex(), projection: relative(root, context), excluded: [], unknown: [], headers: p.headers.context },
    generation: { status: "not-attempted" }, compilation: { status: "not-attempted", commands: [], diagnostics: "" }, comparison: { status: "not-available" },
    integration: { state: existing && !options.alternative ? "live" : "staged", changes: [target.source], blockers: [], destinationHash: hashFile(destination) },
    discovery: { compilerAnalysis: configuredCompilerAnalysis(root), unknowns: [], report: { scope: "whole-member", draftScope: isDirectoryTu(member) ? "selected-function" : "whole-member", selectedFunction: fn.name, member: member.id, input: member.input, ordinal: member.ordinal, originalHash: member.sha256, functions: member.functions }, priorExperiments: [], preflight: [] }, finalization: { status: "not-attempted" } };
  const ledger = join(root, "build/experimentLedger", `${key}.jsonl`);
  if (existsSync(ledger)) packet.discovery.priorExperiments.push(relative(root, ledger));
  packet.diagnosticsIdentity = hashFile(ledger);
  if (syscall) packet.discovery.platformMacros = [syscall.evidence];
  try {
    if (!packet.primary && syscall) {
      const draft = join(directory, "draft.c"); writeFileSync(draft, syscall.source);
      packet.primary = { origin: "platform-macro", path: relative(root, draft), sha256: digest(syscall.source), text: syscall.source, declarationsRequired: [] };
      packet.generation = { status: "generated", draftHash: digest(syscall.source) };
    }
    if (!packet.primary) {
      const m2c = prepareM2c(root);
      // Source/patch content identity lives in the component witness, not an installation-path input.
      const cpp = await recordedCommand(configuredTool("cpp", root), [...configuredFlags("cpp", flagContext, root), context, "-o", join(directory, "context.i")], root, directory, "context-cpp", options.signal);
      packet.discovery.preflight.push(cpp);
      if (cpp.status !== 0) throw new Error(commandText(cpp));
      // A directory TU drafts only this function. Its neighbors and data stay
      // in the ordinary production compile driver, not in the solver's draft.
      const index = emptyDeclarationIndex();
      indexDeclarations(index, readFileSync(join(directory, "context.i"), "utf8"), relative(root, context), member.id, "public-header");
      for (const path of [target.context.types, target.context.functions]) if (existsSync(join(root, path)))
        indexDeclarations(index, readFileSync(join(root, path), "utf8"), path, member.id, "source-local");
      if (isDirectoryTu(member)) {
        const scope = preprocessOnly(member.source, join(directory, "owner-scope"), key, target.flags);
        indexDeclarations(index, readFileSync(scope, "utf8"), relative(root, scope), member.id, "source-local");
      }
      const callees = member.object.relocations.filter(r => r.type === 4 && r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size)
        .flatMap(r => {
          const word = member.object.sections.get(r.section)!.data.readUInt32LE(r.offset);
          if (word >>> 26 !== 3) return [];
          const call = resolveLibraryCall(member, r.reference, (word & 0x3ffffff) * 4, [member]);
          return call ? [call.slice(call.lastIndexOf("::") + 2)] : [];
        });
      const roots = [...(isDirectoryTu(member) ? [fn.name, ...callees, ...index.declarations.filter(d => d.visibility === "source-local" && d.kind === "object").map(d => d.name)] : member.functions.map(fn => fn.name)), ...member.object.symbols.filter(s => s.binding !== 0 && s.name && !s.name.endsWith(".NON_MATCHING")).map(s => s.name)];
      const projection = projectDeclarations(index, roots, member.id), projectedPath = join(directory, "m2c.ctx");
      writeFileSync(projectedPath, projection.text);
      packet.context = { ...packet.context, index, projection: relative(root, projectedPath), excluded: projection.excluded, unknown: projection.unknown };
      let m2cAssembly = assembly;
      if (isDirectoryTu(member)) {
        // Mutable storage belongs to the TU data part, not to this function
        // draft. Keep all code for related-use inference and readonly tables
        // for switch recovery. Without mutable initializers, m2c infers their
        // declarations from uses instead of mistyping MMIO pointers as ints or
        // emitting duplicate definitions alongside the original data backlog.
        const listing = readFileSync(assembly, "utf8"), sections = [...listing.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
        m2cAssembly = join(directory, "function-scope.s");
        writeFileSync(m2cAssembly, listing.slice(0, sections[0]?.index ?? listing.length) + sections.flatMap((s, i) => {
          const original = member.object.sections.get(s[1]!);
          return original && (original.flags & 4 || (!(original.flags & 1) && original.type !== 8))
            ? [listing.slice(s.index!, sections[i + 1]?.index ?? listing.length)] : [];
        }).join("\n"));
      }
      const command = await recordedCommand(configuredTool("python", root), [m2c.script, ...configuredFlags("m2c", flagContext, root), "--no-cache", "--context", projectedPath,
        m2cAssembly, ...(isDirectoryTu(member) ? ["--infer-related", "-f", fn.name] : [])], root, directory, "m2c", options.signal);
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
    if (!guard.parses || guard.includeAsm.length) packet.integration.blockers.push(isDirectoryTu(member) ? "Candidate must be clean C for the selected function" : "Candidate must be clean C for the entire member");
    options.signal?.throwIfAborted();
    const artifacts = await compileSourceAsync(packet.primary.path, join(directory, "compile"), isDirectoryTu(member) ? key : member.id,
      { assemble: true, containerKind: "library", containerId: member.id, ...(options.signal ? { signal: options.signal } : {}) });
    const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
    if (rejection) throw new Error(`Invalid C: ${rejection}`);
    const comparison = compareLibraryCandidate(member, artifacts, isDirectoryTu(member) ? fn.name : undefined);
    const report = join(directory, "comparison.json");
    writeFileSync(report, JSON.stringify({ target: key, scope: "whole-member", ...comparison }, null, 2) + "\n");
    packet.compilation = { ...packet.compilation, status: "succeeded", diagnostics: artifacts.diagnostics,
      preprocessed: { path: relative(root, artifacts.preprocessed), sha256: hashFile(artifacts.preprocessed) },
      assembly: { path: relative(root, artifacts.assembly), sha256: hashFile(artifacts.assembly) }, object: { path: relative(root, artifacts.object!), sha256: hashFile(artifacts.object!) } };
    packet.comparison = { status: comparison.verdict === "match" ? "exact" : comparison.verdict === "mismatch" ? "mismatching" : "undetermined", report: relative(root, report) };
    packet.integration.blockers.push(...sourceConstructFindings(packet.primary.text, loadConfig(root), { name: member.id, container: member.id }).map(f => f.message));
    if (!isDirectoryTu(member) && member.functions.length !== 1) packet.integration.blockers.push("Multi-function TU: integrate explicitly, preserving all neighboring functions and globals; automatic single-stub staging disabled");
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
  if (!options.alternative && packet.primary?.origin === "m2c" && packet.compilation.status === "succeeded")
    writeFileSync(latest, JSON.stringify({ draft: packet.primary.path, destination: target.source, generationContract: "directory-tu-selected-related-v3", boundaryIdentity }) + "\n");
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
