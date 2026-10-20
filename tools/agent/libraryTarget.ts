import { acceptanceToolchain } from "../lib/toolProvenance.js";
import { COMPONENT_CONTRACTS, compilationIdentity, stableHash } from "../lib/cacheIdentity.js";
import { currentScriptArgs } from "../lib/installedScripts.js";
import { contextForProject, projectRoot } from "../lib/runtimeContext.js";
/** Library-mode bridge for npm and the existing Pi preparation/diff/gate loop.
 * Iterations compile the owning TU; acceptance is the entire original member.
 * No original object is ever substituted for missing reconstructed C. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { configuredCompilerAnalysis, configuredFileFlags, configuredFlags, configuredProfile, configuredTool, toolchainExecutables, type FlagContext } from "../lib/toolchain.js";
import { libraryContext, loadLibraryProject, libraryInputFiles } from "../lib/project.js";
import { compareLibraryObjects, libraryInventory, libraryObjectInputs, libraryMembers, libraryTargetKey, materializeOriginal, requireLibraryFunction, resolveLibraryCall, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { compareRelocatableObjects, readRelocatableObject, renderObjectResidual, type ObjectComparison } from "../lib/relocatableObject.js";
import { compareRelocatableFunction } from "../lib/relocatableFunctionOracle.js";
import { libraryDisassemblySymbols, validateLibraryDisassembly } from "../lib/libraryDisassembly.js";
import { libraryAssemblyParts, libraryAssemblyInputs, libraryMemberOrigin, librarySourceScaffold, writeLibraryAssemblyParts } from "../lib/libraryAssembly.js";
import { migrateLibrarySources, writeLibraryTu } from "./librarySources.js";
import { isAssemblyPart, isDirectoryTu, isLibraryDataSymbol, isLibraryGeneratedSymbol, isModulePart, inspectLibraryPart, libraryAssemblyTu, libraryFunctionSource, libraryGeneratedFunction, libraryModulePart, libraryOriginalSha256, librarySourceFiles, libraryTuStatus, readLibraryTu, type LibraryTuForm, type LibraryTuManifest, type LibraryTuPartStatus } from "../lib/libraryTranslationUnit.js";
import { classifyLibraryCode } from "./libraryCodeClass.js";
import { libraryRodataLayout, libraryRodataPartPath } from "../lib/libraryRodata.js";
import { libraryDataObjects, lnkSymbolOrder, m2cGlobalDefinitions, renderDataDraft, renderSymbolOrder } from "./libraryFinishing.js";
import { retainHandwrittenAssembly } from "./retainHandwrittenAssembly.js";
import { libraryFunctionTarget } from "../lib/targetAdapter.js";
import { digest, fileDigest, filesUnder, snapshot, withContentMemo } from "../lib/contentCache.js";
import { count } from "../lib/perfCounters.js";
import { recordedCommand, commandText } from "../lib/recordedCommand.js";
import { compileSource, compileSourceAsync, configuredToolchainIdentity, loadFlagOverrides, preprocessOnly, rejectionFromDiagnostics, runTool, sourceDependencyFiles } from "./decompToolchain.js";
import { withPreprocessorMetadata } from "./preprocessedCache.js";
import { verificationClosure } from "../lib/verificationClosure.js";
import { extractSignaturesFromSource } from "./sdkTypes.js";
import { analyzeCSource } from "./cSourceGuard.js";
import { preservedAttempt } from "./cSourceAnalysis.js";
import { emptyDeclarationIndex, indexDeclarations, projectDeclarations } from "./declarationContext.js";
import { prepareM2c } from "../build/prepareM2c.js";
import { packetOpening, packetEvidence, type PreparationPacket } from "./campaign/packet.js";
import { detectFunctionMacroIdentity } from "../diagnostics/macroIdentity.js";
import { sourceConstructFindings } from "../../.pi/extensions/shared/source-policy.js";
import { loadConfig } from "../../.pi/extensions/shared/config.js";
/* One hashing route: the content memo and its ctime-settled reuse. */
const hashFile = fileDigest;
/** A member's accepted (whole-member match) record. */
export const acceptedPath = (root: string, member: Pick<LibraryMember, "id">) => join(root, "build/libraries/verified", `${member.id}.json`);
function backlogInputs(member: LibraryMember, root: string): string[] {
  if (!isDirectoryTu(member) || !existsSync(join(root, member.source))) return [];
  return libraryTuStatus(member, root)!.filter(p => p.stub && p.form === "c").flatMap(p => libraryAssemblyInputs(member, p.symbol!, root));
}
function memberInputPaths(member: LibraryMember, root: string, inputs?: string[]): string[] {
  const p = loadLibraryProject(root)!;
  const context = libraryContext(member.id, root);
  const cpp = configuredFlags("cpp", context, root);
  const includeDirs = cpp.flatMap((f, i) => f === "-I" ? [cpp[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
  return ["project.json", ...(member.originalObject ? [member.originalObject.input] : []), ...(p.views?.elf[member.id] ? [p.views.elf[member.id]!] : []), ...backlogInputs(member, root), ...(existsSync(join(root, member.source)) ? librarySourceFiles(member, root) : [member.source]), ...(inputs ?? libraryInputFiles(p, root).map(i => i.path)),
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
const includeDirectories = (flags: string[]) => flags.flatMap((f, i) => f === "-I" ? [flags[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []);
/** A finalization's guard: equal before and after means nothing the checked
 * members build from changed in between. It is compared within one
 * finalization and never stored, so it hashes whole directories instead of
 * scanning each TU's dependencies: every source is under `src`, every header
 * either compiler can find is under a configured include directory or header
 * role, and flags follow from the hashed configuration files. A header outside
 * all of those is still covered by the member check's own batch guard, just
 * not across context publication. Tool bytes are hashed once per profile. */
export function libraryWorkspaceIdentity(members: LibraryMember[], root = projectRoot()): string {
  return withContentMemo(() => {
    const project = loadLibraryProject(root)!;
    const paths = new Set(["src", "project.json", "toolchain.json", "configs/flag_overrides.mk",
      ...libraryInputFiles(project, root).map(i => i.path), ...project.headers.reference, ...project.headers.owned]);
    const tools = new Map<string, Record<string, unknown>>();
    const identities = members.map(m => {
      const context = libraryContext(m.id, root, project), profile = configuredProfile(context, root) ?? "";
      if (!tools.has(profile)) {
        tools.set(profile, compilationIdentity(root, context));
        for (const name of ["cpp", "as"] as const) includeDirectories(configuredFlags(name, context, root)).forEach(d => paths.add(d));
      }
      const objects = libraryObjectInputs(m, root, project);
      [...backlogInputs(m, root), ...objects.files].forEach(p => paths.add(p));
      return [m.id, m.sha256, m.inputHash, objects, profile];
    });
    return digest(JSON.stringify({ members: identities, tools: [...tools],
      inputs: snapshot(root, [...paths], f => !f.endsWith(".test.ts") && !f.includes("__pycache__")) }));
  });
}
export function libraryBuildIdentity(member: LibraryMember, root = projectRoot()): string {
  libraryObjectInputs(member, root);
  return digest(JSON.stringify({ target: member.sha256, original: member.originalObject?.sha256, input: member.inputHash,
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
  /* A member's context contributes only its profile and its own file flags to
     the compiler identity; the batch guard catches tool or flag-file changes. */
  const compilers = new Map<string, Record<string, unknown>>();
  const compiler = (context: FlagContext, stem: string) => {
    const key = JSON.stringify([configuredProfile(context, root) ?? null, configuredFileFlags(stem, root)]);
    if (!compilers.has(key)) compilers.set(key, compilationIdentity(root, context, stem));
    return compilers.get(key)!;
  };
  const identity = (member: LibraryMember): string => {
    count("verification.identity");
    const objects = libraryObjectInputs(member, root, project);
    const context = libraryContext(member.id, root, project), cpp = configuredFlags("cpp", context, root);
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
    const paths = [member.source, ...objects.files, ...backlogInputs(member, root), ...(existsSync(join(root, member.source)) ? sourceDependencyFiles(member.source, context, root) : [])];
    const local = snapshot(root, paths, filter); locals.set(member.id, local);
    for (const [path, hash] of Object.entries(local)) {
      if (expected[path] !== undefined && expected[path] !== hash) throw new Error(`Library input changed during batch: ${path}`);
      expected[path] = hash;
    }
    paths.forEach(p => observedPaths.add(p));
    return digest(JSON.stringify({ version: 3, target: member.sha256, original: member.originalObject?.sha256, input: member.inputHash, common: commonHash,
      includes: includes.get(key), tools: compiler(context, member.id), local }));
  };
  const assertUnchanged = () => {
    const after = snapshot(root, [...observedPaths], filter);
    const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));
    if (JSON.stringify(after) !== JSON.stringify(sorted) || tools !== JSON.stringify(compilationIdentity(root)))
      throw new Error("Library batch inputs changed; rerun verification");
  };
  return { identity, assertUnchanged };
}
export function isLibraryMemberVerified(member: LibraryMember, root = projectRoot()): boolean {
  return verifiedLibraryMembers([member], root).get(member.id)!;
}
export function verifiedLibraryMembers(members: LibraryMember[], root = projectRoot()): Map<string, boolean> {
  count("verification.batch");
  /* Include-search membership is walked once for the batch and re-checked when it closes. */
  return withContentMemo(() => withPreprocessorMetadata(() => {
    const batch = libraryBuildIdentities(root), key = libraryVerificationKey(root, loadConfig(root).sourcePolicy);
    const verified = new Map(members.map(member => {
      try {
        return [member.id, recordedMatch(member, batch.identity(member), key, root)] as const;
      } catch { return [member.id, false] as const; }
    }));
    batch.assertUnchanged();
    return verified;
  }));
}

function compileMember(member: LibraryMember, source = member.source, root = projectRoot(), key = member.id) {
  rmSync(join(root, "build/libraries/candidates", member.id), { recursive: true, force: true });
  const artifacts = compileSource(source, `build/libraries/candidates/${member.id}/${randomUUID()}`, key, { assemble: true, containerKind: "library", containerId: member.id });
  const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
  if (rejection) throw new Error(`Invalid C: ${rejection}`);
  return artifacts;
}
export function measureLibraryFunction(name: string, source?: string) {
  const target = requireLibraryFunction(name);
  const artifacts = compileMember(target.member, source ?? (libraryAssemblyTu(target.member, projectRoot()) ? target.member.source : libraryFunctionSource(target.member, target.fn.name)), projectRoot(), target.key);
  const comparison = compareLibraryCandidate(target.member, artifacts, target.fn.name);
  // A finishing target has no code extent: the whole member is its only comparison.
  const local = target.fn.generated ? undefined : compareRelocatableFunction(target.key, artifacts.object!, artifacts.form === "assembly" ? undefined : artifacts.source);
  const functionComparison = local ? { symbol: target.fn.name, verdict: local.verdict, matchedWords: local.same, totalWords: local.targetWords.length }
    : { symbol: target.fn.name, verdict: comparison.verdict, matchedWords: comparison.matchedWords, totalWords: comparison.totalWords };
  const report = join(artifacts.outputDir, "comparison.json");
  writeFileSync(report, JSON.stringify({ target: target.key, scope: "whole-member", memberHash: target.member.sha256, ...comparison, functionComparison }, null, 2) + "\n");
  return { ...target, artifacts, comparison, functionComparison, report };
}
/** Fresh production results for transactional migrations, including mismatches.
 * This is not acceptance and never writes a verified record. */
export function libraryMemberResults(members: LibraryMember[], root = projectRoot()): Map<string, ObjectComparison["verdict"]> {
  return withLibraryMetadata(() => new Map(members.map(member => {
    if (backlogInputsNeeded(member, root)) {
      const listing = disassembleLibraryMember(member, root);
      writeLibraryAssemblyParts(member, libraryAssemblyParts(member, readFileSync(listing, "utf8")), root);
    }
    const artifacts = compileMember(member, undefined, root);
    return [member.id, compareLibraryObjects(member, readFileSync(artifacts.object!)).verdict] as const;
  })), members, root);
}
function backlogInputsNeeded(member: LibraryMember, root: string): boolean {
  return isDirectoryTu(member) && libraryTuStatus(member, root)!.some(p => p.stub && p.form === "c");
}
function compareLibraryCandidate(member: LibraryMember, artifacts: ReturnType<typeof compileSource>, symbol?: string): ObjectComparison {
  const object = readFileSync(artifacts.object!), comparison = compareLibraryObjects(member, object);
  if (isDirectoryTu(member)) {
    const status = libraryTuStatus(member, projectRoot(), symbol && artifacts.form !== "assembly" ? { symbol, source: artifacts.source } : undefined)!;
    const selectedStub = status.some(p => p.symbol === symbol && p.stub);
    return selectedStub ? { ...comparison, verdict: "stub", differences: ["Selected function is still an assembly backlog stub", ...comparison.differences] } : comparison;
  }
  const stubs = analyzeCSource(readFileSync(artifacts.source, "utf8")).includeAsm;
  if (stubs.length) return { ...comparison, verdict: "stub",
    differences: ["Member still contains INCLUDE_ASM/assembly-backed data; reference assembly is not reconstructed C", ...comparison.differences] };
  return comparison;
}
export function renderLibraryComparison(comparison: ObjectComparison, selected?: { symbol: string; verdict: string; matchedWords: number; totalWords: number }): string {
  const percent = comparison.totalWords ? (comparison.matchedWords / comparison.totalWords * 100).toFixed(2) : "0.00";
  return [`target: ${comparison.totalWords} instrs, candidate: ${comparison.candidateWords} instrs`,
    `Match: ${comparison.matchedWords}/${comparison.totalWords} words (${percent}%)`,
    `VERDICT: ${comparison.verdict.toUpperCase()}`, "Scope: complete original/rebuilt object SHA-256 (native .OBJ); legacy ELF uses relocatable-object identity",
    ...(selected ? [`Selected function: ${selected.symbol}: ${selected.verdict.toUpperCase()} (${selected.matchedWords}/${selected.totalWords} words)`] : []),
    ...renderObjectResidual(comparison),
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
  const statuses = new Map(members.filter(m => isDirectoryTu(m) && existsSync(join(root, m.source))).map(m => [m.id, new Map(libraryTuStatus(m, root)!.map(p => [p.symbol, p]))]));
  const forms = new Map(members.map(m => [m.id, libraryMemberForm(m, root)]));
  const entries = members.flatMap(member => member.functions.map(fn => {
    const target = libraryFunctionTarget(member, fn, root);
    const assemblyClass = classifyLibraryCode(member.object, fn);
    const part = statuses.get(member.id)?.get(fn.name), retainedC = part?.form === "c" && part.retained !== undefined;
    return { name: target.key, symbol: target.symbol, container: target.owner.id, source: target.source,
      includeAsmPath: target.includeAsm.folder, assembly: target.assembly.function, verification: target.verification,
      vram: `symbol:${target.symbol}`, section: fn.section, sectionOffset: fn.offset, size: fn.size,
      inferredSize: fn.inferredSize, tier: 1, priority: 0, callerCount: 0, calls: [] as string[], calledBy: [] as string[], instructionCount: Math.ceil(fn.size / 4),
      decompiled: verified.get(member.id)! && (!isDirectoryTu(member) || part?.stub === false), handwritten: forms.get(member.id) === "assembly" || retainedC ? "asm" as const : false as const, dead: false,
      libraryStub: forms.get(member.id) === "c" && part?.stub === true,
      sourceForm: forms.get(member.id)!,
      ...(libraryAssemblyTu(member, root)?.part.handwritten ? { retainedHandwrittenAssembly: true } : {}),
      ...(retainedC ? { retainedHandwrittenAssembly: true, retainedClass: part!.retained! } : {}),
      ...(assemblyClass ? { assemblyClass } : {}) };
  }));
  entries.push(...members.flatMap(member => libraryFinishingEntries(member, forms.get(member.id)!, statuses.get(member.id), root)));
  const byName = new Map(entries.map(e => [e.name, e]));
  for (const member of members) for (const fn of member.functions) {
    const entry = byName.get(libraryTargetKey(member, fn.name))!;
    for (const r of member.object.relocations.filter(r => r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size && r.type === 4)) {
      if (r.addend === null) continue;
      const addend = r.addend ?? (member.object.sections.get(r.section)!.data.readUInt32LE(r.offset) & 0x3ffffff) * 4;
      const target = resolveLibraryCall(member, r.reference, addend, members);
      if (target && target !== entry.name) entry.calls.push(target);
    }
    entry.calls = [...new Set(entry.calls)];
  }
  for (const entry of entries) for (const call of entry.calls) byName.get(call)!.calledBy.push(entry.name);
  for (const entry of entries) { entry.callerCount = entry.calledBy.length; entry.priority = entry.callerCount; }
  const graph = { targetKind: "relocatable-library", identityKind: "member-symbol", functions: entries,
    stats: { totalFunctions: entries.length, totalMembers: members.length, verifiedMembers: [...verified.values()].filter(Boolean).length,
      assemblyOnlyFunctions: entries.filter(entry => entry.handwritten === "asm").length,
      assemblySourceFunctions: entries.filter(entry => entry.sourceForm === "assembly").length,
      retainedCFunctions: entries.filter(entry => "retainedClass" in entry).length,
      finishingTargets: entries.filter(entry => "finishing" in entry).length,
      unflaggedClassifierHits: entries.filter(entry => entry.sourceForm === "c" && "assemblyClass" in entry && !("retainedClass" in entry)).length } };
  mkdirSync(join(root, "build"), { recursive: true }); writeFileSync(join(root, "build/callGraph.json"), JSON.stringify(graph, null, 2) + "\n");
  return graph;
}
/** Member-finishing targets: each generated data part (the member data and the
 * .rdata in front of each switch table) once every function is C or retained,
 * then the symbol-order part once the data is C too. Data-only members are
 * ready at once. They have no code extent; the whole member is the oracle. */
function libraryFinishingEntries(member: LibraryMember, form: LibraryTuForm, status: Map<string | undefined, LibraryTuPartStatus> | undefined, root: string) {
  if (form !== "c" || !status) return [];
  const functionsDone = member.functions.every(fn => { const part = status.get(fn.name); return part && (!part.stub || part.retained); });
  const data = [...status.values()].filter(p => isLibraryDataSymbol(p.symbol)), symbols = status.get("__library_member_symbols");
  const ready = [
    ...(functionsDone ? data.filter(p => p.stub).map(p => p.symbol!) : []),
    ...(functionsDone && symbols?.stub && data.every(p => !p.stub) ? ["__library_member_symbols"] : []),
  ];
  return ready.map(symbol => {
    const fn = libraryGeneratedFunction(symbol), target = libraryFunctionTarget(member, fn, root);
    return { name: target.key, symbol, container: member.id, source: target.source, includeAsmPath: target.includeAsm.folder, assembly: target.assembly.function,
      verification: target.verification, vram: `symbol:${symbol}`, section: "", sectionOffset: 0, size: 0, inferredSize: false, tier: 1, priority: 0, callerCount: 0,
      calls: [] as string[], calledBy: [] as string[], instructionCount: 0, decompiled: false, handwritten: false as const, dead: false, libraryStub: true,
      sourceForm: "c" as LibraryTuForm, finishing: fn.generated };
  });
}
/** Hand-written functions of C members, recorded in their manifests so the
 * decision is explicit and reviewed in git; the graph reads the flag, never the
 * classifier alone. Add-only: an existing flag is revalidated on every read. A
 * fingerprint on a function already written as C is an error, not a flag. */
export function planRetainedFlags(members: LibraryMember[], root: string): { changes: Array<{ member: LibraryMember; manifest: LibraryTuManifest }>; errors: string[] } {
  const changes: Array<{ member: LibraryMember; manifest: LibraryTuManifest }> = [], errors: string[] = [];
  for (const member of members) {
    if (!isDirectoryTu(member) || !existsSync(join(root, member.source)) || libraryAssemblyTu(member, root)) continue;
    const manifest = readLibraryTu(member, root), status = libraryTuStatus(member, root)!;
    let changed = false;
    for (const part of manifest.parts) {
      const fn = part.symbol && !part.retained ? member.functions.find(f => f.name === part.symbol) : undefined;
      const evidence = fn && classifyLibraryCode(member.object, fn);
      if (!evidence) continue;
      if (!status.find(p => p.path === part.path)?.stub) { errors.push(`${libraryTargetKey(member, fn.name)}: written as C, but its original words are hand-written (${evidence.detail})`); continue; }
      part.retained = { kind: "handwritten-assembly", evidence: evidence.kind, originalSha256: libraryOriginalSha256(member) };
      changed = true;
    }
    if (changed) changes.push({ member, manifest });
  }
  return { changes, errors };
}
export function applyRetainedFlags(members: LibraryMember[], root: string): number {
  const plan = planRetainedFlags(members, root);
  if (plan.errors.length) throw new Error(`C sources for hand-written functions:\n${plan.errors.join("\n")}`);
  for (const { member, manifest } of plan.changes) writeFileSync(join(root, member.source), JSON.stringify(manifest, null, 2) + "\n");
  return plan.changes.length;
}
/** A C member whose data is still extraction gets the part holding the .rdata
 * in front of each switch table, placed before the table's owner. When its
 * switch tables were all the data it had, its data stub goes: a fresh split
 * would not write one. */
export function ensureRodataParts(member: LibraryMember, parts: ReturnType<typeof libraryAssemblyParts>, root: string): void {
  const path = join(root, member.source);
  if (!isDirectoryTu(member) || !existsSync(path)) return;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as LibraryTuManifest, directory = dirname(path);
  if (manifest.parts.some(p => isAssemblyPart(p) || isModulePart(p))) return;
  const data = manifest.parts.find(p => p.symbol === "__library_member_data");
  if (!data || !inspectLibraryPart(readFileSync(join(directory, data.path), "utf8"), data).stub) return;
  const emptied = libraryRodataLayout(member).tables.length > 0 && !parts.some(p => p.symbol === "__library_member_data");
  let changed = emptied;
  if (emptied) manifest.parts.splice(manifest.parts.indexOf(data), 1);
  for (const segment of libraryRodataLayout(member).segments) {
    if (!parts.some(p => p.symbol === segment.symbol) || manifest.parts.some(p => p.symbol === segment.symbol)) continue;
    const owner = manifest.parts.findIndex(p => p.symbol === segment.owner);
    if (owner < 0) throw new Error(`${member.id}: switch table owner ${segment.owner} is not a part of ${member.source}`);
    const file = libraryRodataPartPath(segment.symbol), text = `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", ${segment.symbol});\n`;
    if (existsSync(join(directory, file)) && readFileSync(join(directory, file), "utf8") !== text) throw new Error(`${member.id}: ${file} exists outside the manifest; no edits made`);
    writeFileSync(join(directory, file), text);
    manifest.parts.splice(owner, 0, { path: file, symbol: segment.symbol });
    changed = true;
  }
  if (changed) writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  if (emptied) rmSync(join(directory, data.path));
}
/** A C member's ordered symbol declarations, while any part is still extraction. */
export function ensureSymbolsPart(member: LibraryMember, parts: ReturnType<typeof libraryAssemblyParts>, root: string): void {
  const path = join(root, member.source);
  if (!isDirectoryTu(member) || libraryAssemblyTu(member, root) || libraryModulePart(member, root) || !parts.some(p => p.symbol === "__library_member_symbols") || !libraryTuStatus(member, root)!.some(p => p.stub)) return;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.parts.some((p: { symbol?: string }) => p.symbol === "__library_member_symbols")) return;
  writeFileSync(join(dirname(path), "_symbols.c"), `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", __library_member_symbols);\n`);
  manifest.parts.unshift({ path: "_symbols.c", symbol: "__library_member_symbols" });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}
/** GCC-compiled native members (LNK symbol IDs from 3) are C TUs; only
 * assembly-origin members are assembly TUs. Members without native records
 * have no origin evidence and are not judged. */
export function tuFormOriginMismatches(members: LibraryMember[], root: string): LibraryMember[] {
  return members.filter(m => isDirectoryTu(m) && m.originalObject?.object.records && existsSync(join(root, m.source)) && libraryAssemblyTu(m, root) && libraryMemberOrigin(m) === "c");
}
export function assertTuFormsMatchOrigin(members: LibraryMember[], root: string): void {
  const mismatched = tuFormOriginMismatches(members, root);
  if (mismatched.length) throw new Error(`Assembly TU for GCC-compiled members (their original objects carry the compiler's symbol IDs): ${mismatched.map(m => m.id).join(", ")}. ` +
    `Convert them with \`npm run library -- reform --member ID --write\`; hand-written functions inside them stay retained.`);
}
export function splitLibrary(root = projectRoot()): void {
  const project = loadLibraryProject(root)!, members = libraryMembers(root);
  // Validate the whole batch before changing live manifests or publishing new
  // backlog fragments. Failed disassembly must not leave a half-migrated TU.
  const staged = members.map(member => {
    const assembly = disassembleLibraryMember(member, root);
    return { member, parts: libraryAssemblyParts(member, readFileSync(assembly, "utf8")) };
  });
  assertTuFormsMatchOrigin(members, root);
  const moves = migrateLibrarySources(members, project, root);
  if (moves.length) console.log(`Migrated ${moves.length} library sources to their derived paths; function/declaration order preserved.`);
  for (const { member, parts } of staged) {
    writeLibraryAssemblyParts(member, parts, root);
    const path = join(root, member.source);
    const assemblyBacklog = isDirectoryTu(member) && !libraryAssemblyTu(member, root)?.part.handwritten && parts[0]?.translationUnit !== undefined && libraryMemberOrigin(member) === "assembly" &&
      (!existsSync(path) || libraryTuStatus(member, root)!.every(p => p.stub || (!p.symbol && !readFileSync(p.source, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*#\s*include[^\n]*/gm, "").trim())));
    if (assemblyBacklog) {
      const source = "backlog.ASM";
      mkdirSync(dirname(path), { recursive: true });
      const old = existsSync(join(dirname(path), source)) ? readFileSync(join(dirname(path), source), "utf8") : "";
      const parked = old.search(/^\/\* PSX parked attempt/m);
      writeFileSync(join(dirname(path), source), parts[0]!.translationUnit! + (parked < 0 ? "" : old.slice(parked)));
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: source, symbols: member.functions.map(f => f.name), backlog: true }] }, null, 2) + "\n");
    } else if (!existsSync(path)) {
      if (isDirectoryTu(member)) writeLibraryTu(member, librarySourceScaffold(member, project.headers.context, parts), root);
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, librarySourceScaffold(member, project.headers.context, parts)); }
    }
    ensureRodataParts(member, parts, root);
    ensureSymbolsPart(member, parts, root);
  }
  // An assembly-origin member's backlog becomes its verbatim retained extraction
  // in the same split: a new SDK reaches the final assembly-TU form with no manual step.
  const backlog = members.filter(m => m.originalObject && libraryAssemblyTu(m, root)?.part.backlog && !libraryAssemblyTu(m, root)?.part.handwritten);
  if (backlog.length) console.log(`Retained ${retainHandwrittenAssembly(true, root, backlog).members.filter(m => !m.alreadyRetained).length} assembly-origin members as verbatim original extraction.`);
  const flagged = applyRetainedFlags(members, root);
  if (flagged) console.log(`Recorded hand-written functions in ${flagged} C member manifests (retained extraction, never C targets).`);
  mkdirSync(join(root, "build/libraries"), { recursive: true });
  writeFileSync(join(root, "build/libraries/inventory.json"), JSON.stringify(libraryInventory(root), null, 2) + "\n");
  writeLibraryGraph(root);
  console.log("Library members indexed; original objects/disassembly stay under build/libraries. Existing function bodies preserved.");
}
/** The source form a member is reconstructed in: its one `.s` (hand-written
 * original) or C parts. Unsplit members count as C: that is the default form. */
export function libraryMemberForm(member: LibraryMember, root = projectRoot()): LibraryTuForm {
  return libraryAssemblyTu(member, root) ? "assembly" : "c";
}
export function libraryProgress(args: string[] = [], root = projectRoot()): void {
  const members = libraryMembers(root), verified = verifiedLibraryMembers(members, root);
  const rows = members.map(m => ({ id: m.id, input: m.input, member: m.member, ordinal: m.ordinal, source: m.source, form: libraryMemberForm(m, root),
    functions: m.functions.map(f => libraryTargetKey(m, f.name)), completedFunctions: verified.get(m.id) ? (isDirectoryTu(m) ? libraryTuStatus(m, root)!.filter(p => p.symbol && !isLibraryGeneratedSymbol(p.symbol) && !p.stub).map(p => libraryTargetKey(m, p.symbol!)) : m.functions.map(f => libraryTargetKey(m, f.name))) : [], complete: verified.get(m.id)! && (!isDirectoryTu(m) || libraryTuStatus(m, root)!.every(p => !p.stub)),
    translationComplete: verified.get(m.id)! && (!isDirectoryTu(m) || libraryTuStatus(m, root)!.every(p => !p.stub || p.retained)),
    retainedFunctions: isDirectoryTu(m) ? libraryTuStatus(m, root)!.filter(p => p.symbol && p.retained).length : 0, codeBytes: [...m.object.sections.values()].filter(s => s.flags & 4).reduce((n, s) => n + s.size, 0), verified: verified.get(m.id)! }));
  const done = rows.filter(r => r.complete), doneC = done.filter(r => r.form === "c"), doneAssembly = done.filter(r => r.form === "assembly");
  const completed = (form: LibraryTuForm) => rows.filter(r => r.form === form).reduce((n, r) => n + r.completedFunctions.length, 0);
  const report = { targetKind: "relocatable-library", scope: "fresh whole-member bytes; a function counts as C when its own file is clean C, as assembly when its member is one verified .s",
    members: { verified: rows.filter(r => r.verified).length, reconstructed: done.length, reconstructedC: doneC.length, reconstructedAssembly: doneAssembly.length, assemblyForm: rows.filter(r => r.form === "assembly").length, translationComplete: rows.filter(r => r.translationComplete).length, total: rows.length },
    functions: { verified: rows.reduce((n, r) => n + r.completedFunctions.length, 0), verifiedC: completed("c"), verifiedAssembly: completed("assembly"), retained: rows.reduce((n, r) => n + r.retainedFunctions, 0), total: rows.reduce((n, r) => n + r.functions.length, 0) },
    codeBytes: { verified: done.reduce((n, r) => n + r.codeBytes, 0), verifiedC: doneC.reduce((n, r) => n + r.codeBytes, 0), verifiedAssembly: doneAssembly.reduce((n, r) => n + r.codeBytes, 0), total: rows.reduce((n, r) => n + r.codeBytes, 0) },
    unresolvedCodeMembers: rows.filter(r => r.codeBytes > 0 && !r.functions.length).map(r => r.id), rows };
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Reconstructed library members: ${done.length}/${rows.length} (C ${doneC.length}, assembly ${doneAssembly.length}); functions: ${report.functions.verified}/${report.functions.total} (C ${report.functions.verifiedC}, assembly ${report.functions.verifiedAssembly}); code bytes: ${report.codeBytes.verified}/${report.codeBytes.total} (C ${report.codeBytes.verifiedC}, assembly ${report.codeBytes.verifiedAssembly})`);
    console.log(`Translation-complete members (every part C or retained hand-written assembly): ${report.members.translationComplete}/${rows.length}; retained hand-written functions: ${report.functions.retained}.`);
    console.log("All members remain in scope, including data-only and unresolved code. SDK names are not excluded; assembly counts only members whose one .s source is byte-verified.");
    if (args.some(a => ["--list", "--remaining", "--done", "--markdown"].includes(a))) for (const r of rows.filter(r => args.includes("--remaining") ? !r.complete : args.includes("--done") ? r.complete : true))
      console.log(`${r.complete ? (r.form === "assembly" ? "MATCH-ASM" : "MATCH-C") : "pending"}\t${r.id}\t${r.input}[${r.ordinal}] ${r.member}\t${r.source}`);
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
  const config = loadConfig(root), key = libraryVerificationKey(root, config.sourcePolicy);
  const toolchains = new Map<string, ReturnType<typeof acceptanceToolchain>>();
  for (const member of selected) {
    const context = libraryContext(member.id, root), profile = configuredProfile(context, root) ?? "";
    if (!toolchains.has(profile)) toolchains.set(profile, acceptanceToolchain(root, context, loadLibraryProject(root)!.verification.mode === "original-object"));
  }
  /* The per-function gate (--member) recompiles its active members. Any other
     accepted member stands on its record when that record matched these exact
     inputs, tools and flags under this harness and source policy. --accepted
     and unscoped checks recompile every member they select. */
  const reusable = (member: LibraryMember, identity: string) => ids.length > 0 && !ids.includes(member.id) && recordedMatch(member, identity, key, root);
  const batch = libraryBuildIdentities(root), records: Array<{ member: LibraryMember; comparison: ObjectComparison; identity: string }> = [];
  let reused = 0;
  const failures: string[] = [];
  withLibraryMetadata(() => { for (const member of selected) {
    try {
    const identity = batch.identity(member);
    if (reusable(member, identity)) { reused++; console.log(`${member.id}: unchanged since its recorded whole-member match`); continue; }
    const artifacts = compileMember(member, undefined, root);
    if (artifacts.form === "assembly") {
      // The .s was inspected for backlog markers when its status rows were
      // read during the compile; the object oracle decides everything else.
      if (!libraryTuStatus(member, root)!.every(p => p.form === "assembly")) throw new Error(`${member.id}: assembly translation unit cannot mix C parts`);
    } else {
    const source = isDirectoryTu(member) ? "" : readFileSync(artifacts.source, "utf8"), guard = analyzeCSource(source), signatures = extractSignaturesFromSource(source);
    const module = libraryModulePart(member, root), retainedIncludeAsm = new Set(Object.keys(module?.retainedFunctions ?? {}));
    const findings = module ? sourceConstructFindings(readFileSync(join(root, dirname(member.source), module.path), "utf8"), config, { name: member.id, container: member.id, retainedIncludeAsm })
      : isDirectoryTu(member) ? libraryTuStatus(member, root)!.flatMap(part => part.stub ? [] : sourceConstructFindings(readFileSync(part.source, "utf8"), config, { name: part.symbol ? libraryTargetKey(member, part.symbol) : member.id, container: member.id })) : sourceConstructFindings(source, config, { name: member.id, container: member.id });
    const includesGeneratedContext = /#\s*\d+\s+"[^"]*build\/libraries\/context\//.test(readFileSync(artifacts.preprocessed, "utf8"));
    if (!guard.parses || guard.includeAsm.length || includesGeneratedContext || findings.length || (!isDirectoryTu(member) && member.functions.some(f => !signatures.some(s => s.name === f.name))))
      throw new Error(`${member.id}: complete clean-C member required (${findings.map(f => f.message).join("; ")})`);
    }
    const comparison = compareLibraryObjects(member, readFileSync(artifacts.object!));
    console.log(`${member.id}: ${renderLibraryComparison(comparison)}`);
    const mismatchPath = join(root, "build/libraries/mismatches", `${member.id}.json`);
    if (comparison.verdict !== "match") {
      mkdirSync(dirname(mismatchPath), { recursive: true });
      writeFileSync(mismatchPath, JSON.stringify({ ...comparison, candidatePath: artifacts.object, source: member.source }, null, 2) + "\n");
      throw new Error(`${member.id}: whole-member verdict ${comparison.verdict}; ${comparison.differences.join("; ")}`);
    }
    rmSync(mismatchPath, { force: true });
    records.push({ member, comparison, identity });
    // Preserve the assembler's argv, unchanged-input hash and every declared
    // stage replacement before removing the larger successful compile bundle.
    const receipt = `${artifacts.object}.assembly.json`;
    if (existsSync(receipt)) {
      const destination = join(root, "build/libraries/receipts", `${member.id}.assembly.json`);
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(receipt));
    }
    rmSync(artifacts.outputDir, { recursive: true, force: true });
    } catch (error) {
      const message = `${member.id}: ${String(error)}`;
      failures.push(message); console.error(message);
    }
  } }, members, root);
  batch.assertUnchanged();
  for (const { member, comparison, identity } of records) {
    const path = acceptedPath(root, member); mkdirSync(dirname(path), { recursive: true });
    const status = isDirectoryTu(member) ? libraryTuStatus(member, root) : undefined;
    writeFileSync(path, JSON.stringify({ ...comparison, scope: "whole-member", identityVersion: 3, identity, verificationKey: key, originalHash: member.originalObject?.sha256 ?? member.sha256, source: member.source,
      toolchain: toolchains.get(configuredProfile(libraryContext(member.id, root), root) ?? ""),
      assemblerReceipt: `build/libraries/receipts/${member.id}.assembly.json`,
      form: status?.every(p => p.form === "assembly") ? "assembly" : "c",
      reconstructed: status ? status.every(p => !p.stub) : true,
      final: status ? status.every(p => !p.stub || p.retained) : true,
      retainedFunctions: status ? status.filter(p => p.symbol && p.retained).map(p => p.symbol) : [],
      completedFunctions: status ? status.filter(p => p.symbol && !isLibraryGeneratedSymbol(p.symbol) && !p.stub).map(p => p.symbol) : member.functions.map(f => f.name) }, null, 2) + "\n");
  }
  if (failures.length) throw new Error(`${failures.length}/${selected.length} library members failed verification:\n${failures.join("\n")}`);
  console.log(scoped ? `Verified ${selected.length} active/previously accepted member(s)${reused ? ` (${reused} unchanged since their recorded match)` : ""}; ${members.length - selected.length} backlog member(s) not verified.` : `All ${selected.length} configured library members are byte-exact; explicit assembly backlog is not decompiled C.`);
}
/** What a recorded match rests on besides its build identity: the harness that
 * compiled, compared and audited the member, and the policy it was audited under. */
export function libraryVerificationKey(root: string, policy: unknown): string {
  const harness = contextForProject(root).harnessRoot;
  return digest(JSON.stringify({ policy, closure: "verification-closure-v1",
    harness: verificationClosure(harness).map(f => [f, fileDigest(join(harness, f))]) }));
}
function recordedMatch(member: LibraryMember, identity: string, key: string, root: string): boolean {
  try {
    const record = JSON.parse(readFileSync(acceptedPath(root, member), "utf8"));
    return record.verdict === "match" && record.identityVersion === 3 && record.identity === identity && record.verificationKey === key;
  } catch { return false; }
}
/** A C draft of one generated data part: m2c's global definitions over the
 * whole member listing, headed by the part's original sections, sizes and linkage. */
async function libraryDataDraft(member: LibraryMember, symbol: string, root: string, directory: string, m2cFlags: string[], headers: string[], packet: PreparationPacket, signal?: AbortSignal): Promise<string> {
  const command = await recordedCommand(configuredTool("python", root), [prepareM2c(root).script, ...m2cFlags, "--no-cache", "--globals=all", join(root, member.assembly)], root, directory, "m2c", signal);
  packet.generation.command = command; packet.generation.raw = relative(root, command.stdout); packet.generation.rawHash = hashFile(command.stdout);
  const listing = ["ASM", "s"].map(ext => `build/libraries/nonmatchings/${member.id}/${symbol}.${ext}`).find(path => existsSync(join(root, path)));
  const objects = listing ? libraryDataObjects(readFileSync(join(root, listing), "utf8")) : [];
  return renderDataDraft(headers, objects, command.status === 0 ? m2cGlobalDefinitions(readFileSync(command.stdout, "utf8")) : [], listing ?? "the member's data listing");
}
export async function prepareLibraryFunction(name: string, options: { root?: string; signal?: AbortSignal; alternative?: boolean; contextFile?: string } = {}) {
  const root = options.root ?? projectRoot(), { member, fn, key } = requireLibraryFunction(name, root), p = loadLibraryProject(root)!;
  const target = libraryFunctionTarget(member, fn, root);
  const assemblyTu = libraryAssemblyTu(member, root);
  if (assemblyTu) throw new Error(`${key}: ${member.id} is reconstructed as an assembly translation unit (${assemblyTu.part.path}); there is no C to prepare`);
  if (libraryModulePart(member, root)) throw new Error(`${key}: ${member.id} is a folded module; every function is already C or retained`);
  if (fn.generated && !(isDirectoryTu(member) && libraryTuStatus(member, root)!.some(p => p.symbol === fn.name))) throw new Error(`${key}: ${member.id} has no generated ${target.source} part to finish`);
  options.signal?.throwIfAborted();
  const assembly = disassembleLibraryMember(member, root);
  const destination = join(root, target.source), source = existsSync(destination) ? readFileSync(destination, "utf8") : "";
  const attempt = preservedAttempt(source);
  const primarySource = attempt ?? source;
  const existing = fn.generated ? attempt !== undefined : extractSignaturesFromSource(primarySource).length > 0;
  const latest = join(root, "build/preparation", key, "latest-library.json");
  const boundaryIdentity = stableHash(member.functions.map(f => [f.name, f.section, f.offset, f.size]));
  let retained: PreparationPacket["primary"] = null;
  if (!existing && !options.alternative && !fn.generated) {
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
  /* The read-before-definition scan needs only the target's assembly, written
     above; it runs alongside generation and compilation. */
  const readBeforeDefinition = fn.generated ? undefined
    : recordedCommand(process.execPath, currentScriptArgs("tools/agent/scanReadBeforeDef.ts", [key, "--json"]), root, directory, "read-before-definition", options.signal);
  readBeforeDefinition?.catch(() => undefined);
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
  const preservedPath = join(directory, "preserved-attempt.c");
  if (attempt) writeFileSync(preservedPath, attempt);
  const packet: PreparationPacket = { schemaVersion: 1, preparationState: "running", preparationScope: fn.generated ? "member-finishing" : isDirectoryTu(member) ? "function" : "translation-unit", identity: { compatibility: COMPONENT_CONTRACTS.preparation, functionName: key, symbol: fn.name, targetKind: "relocatable-library", container: member.id,
    destination: target.source, assembly: existsSync(join(root, target.assembly.function)) ? target.assembly.function : target.assembly.translationUnit,
    data: [member.original], inputs, memberships, fingerprint: digest(JSON.stringify({ inputs, memberships })), tools: { compilation: compilationIdentity(root, target.flags, member.id), m2c: { compatibility: "patched-m2c-v1", source: prepareM2c(root).identity.sha256, flags: configuredFlags("m2c", target.flags, root) }, context: COMPONENT_CONTRACTS.context }, flags },
    verification: target.verification,
    primary: existing && !options.alternative ? { origin: "existing-attempt", path: attempt ? relative(root, preservedPath) : target.source, sha256: digest(primarySource), text: primarySource, declarationsRequired: [] } : retained,
    context: { index: emptyDeclarationIndex(), projection: relative(root, context), excluded: [], unknown: [], headers: p.headers.context },
    generation: { status: "not-attempted" }, compilation: { status: "not-attempted", commands: [], diagnostics: "" }, comparison: { status: "not-available" },
    integration: { state: existing && !options.alternative && !attempt ? "live" : "staged", changes: [target.source], blockers: [], destinationHash: hashFile(destination) },
    discovery: { compilerAnalysis: configuredCompilerAnalysis(root), unknowns: [], report: { scope: "whole-member", draftScope: isDirectoryTu(member) ? "selected-function" : "whole-member", selectedFunction: fn.name, member: member.id, input: member.input, ordinal: member.ordinal, originalHash: member.sha256, functions: member.functions }, priorExperiments: [], preflight: [] }, finalization: { status: "not-attempted" } };
  const ledger = join(root, "build/experimentLedger", `${key}.jsonl`);
  if (existsSync(ledger)) packet.discovery.priorExperiments.push(relative(root, ledger));
  packet.diagnosticsIdentity = hashFile(ledger);
  try {
    if (!packet.primary && fn.generated) {
      const draft = join(directory, "draft.c"), text = fn.generated === "data"
        ? await libraryDataDraft(member, fn.name, root, directory, configuredFlags("m2c", flagContext, root), p.headers.context, packet, options.signal)
        : "/* Symbol IDs now come from the C itself: definitions, statics and first external references, in source order. */\n";
      writeFileSync(draft, text);
      packet.primary = { origin: "generated-part", path: relative(root, draft), sha256: digest(text), text, declarationsRequired: [] };
      packet.generation = { ...packet.generation, status: "generated", draftHash: digest(text) };
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
          if (word >>> 26 !== 3 || r.addend === null) return [];
          const call = resolveLibraryCall(member, r.reference, r.addend ?? (word & 0x3ffffff) * 4, [member]);
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
    if (fn.generated && member.originalObject) {
      const order = join(directory, "symbol-order.txt");
      writeFileSync(order, renderSymbolOrder(lnkSymbolOrder(member.originalObject.bytes), lnkSymbolOrder(readFileSync(artifacts.object!))) + "\n");
      packet.discovery.finishing = { kind: fn.generated, report: relative(root, order) };
    }
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
  // Function diagnostics have nothing to read in a finishing target's data or symbol order.
  // The handoff renders macro identity, so it is computed here; full triage
  // (idiom precedents, symptom findings) is psx_triage, on demand.
  const unknown = (subject: string, error: unknown, attempted: string) => packet.discovery.unknowns.push({ subject, strength: "unknown", constraints: [], evidence: [member.assembly],
    missing: String(error), attempted, bound: "selected function/TU", stoppedBecause: "diagnostic failed", inspectNext: [relative(root, directory)] });
  if (readBeforeDefinition) {
    try {
      const result = await readBeforeDefinition;
      packet.discovery.preflight.push(result);
      if (result.status !== 0) throw new Error(commandText(result));
      packet.discovery.readBeforeDefinition = JSON.parse(readFileSync(result.stdout, "utf8"));
    } catch (error) { unknown("read-before-definition", error, "shared scanReadBeforeDef.ts"); }
    try {
      packet.discovery.macroIdentity = detectFunctionMacroIdentity(key);
      packet.discovery.report = { ...packet.discovery.report as object, triage: "on demand: psx_triage" };
    } catch (error) { unknown("macro-identity", error, "shared macro identity"); }
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
