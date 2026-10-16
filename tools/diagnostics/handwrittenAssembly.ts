/** Heuristic census of original MIPS words. Read-only except an explicitly
 * requested build/ JSON report. No compiler runs, source emission, exemptions,
 * source reclassification, autoloop changes or progress claims. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeHandwrittenModule, type HandwrittenFunction, type HandwrittenReading } from "../lib/handwrittenAssembly.js";
import { digest, writeIfChanged } from "../lib/contentCache.js";
import { projectRoot } from "../lib/runtimeContext.js";
import { loadToolchain, configuredFlags } from "../lib/toolchain.js";
import { loadContainers, unresolvedCodeMembers } from "../lib/container.js";
import { libraryContext, loadLibraryProject } from "../lib/project.js";
import { libraryMemberById, requireLibraryFunction, withLibraryMetadata } from "../lib/libraryTargets.js";
import { relocatableAddend } from "../lib/relocatableFunctionOracle.js";
import { resolveFunctionTarget } from "../lib/targetAdapter.js";
import { parseC, walk, declaratorName } from "../agent/residual-source-search/tree-sitter-c.js";
import { loadMacroFunctions, type CensusFinding } from "./macroIdentity.js";

export type SourceStatus = "C" | "INCLUDE_ASM" | "assembly" | "missing" | "unresolved";
export interface AssemblySource { path: string; status: SourceStatus; sha256: string | null; reason?: string }
export interface AssemblyScanRow extends HandwrittenReading {
  source: AssemblySource; eligibleForAssembly: boolean;
  disposition: "assembly-candidate" | "keep-existing-C" | "already-assembly" | "inspect" | "continue-C" | "source-unresolved";
  owner: { source: string; input?: string; member?: string; sha256?: string };
}
export interface AssemblyScanOptions {
  functionNames?: readonly string[]; containerIds?: readonly string[]; threshold?: number;
}
export interface AssemblyScanReport {
  schemaVersion: 1; scannerVersion: 4; architecture: "MIPS-I/R3000";
  scope: "project" | "selected-functions" | "selected-containers";
  complete: boolean; threshold: number;
  toolchain: { sha256: string; compiler: { family: string; version: string }; configuredNotIdentified: true };
  contexts: Array<{ container: string; cc1: string[]; assembler: string[] }>;
  summary: { scanned: number; high: number; medium: number; low: number; undetermined: number; existingC: number; assemblyCandidates: number; incompleteAnalyses: number };
  findings: CensusFinding[]; functions: AssemblyScanRow[];
  modules: Array<{ container: string; source: string; functions: string[]; candidates: string[]; existingC: string[]; allFunctionsScanned: boolean; wholeAssemblyCandidate: boolean }>;
  limitations: string[];
}

/** Source status protects existing C; it never contributes to origin scores.
 * Unknown preprocessing and mixed definitions fail closed, not as permission
 * to overwrite a failed or partially reconstructed C attempt. */
export function assemblySourceStatus(path: string, symbol: string, root = projectRoot()): AssemblySource {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return { path, status: "missing", sha256: null };
  const text = readFileSync(absolute, "utf8"), sha256 = digest(text);
  if (/\.[sS]$/.test(path)) return { path, status: "assembly", sha256 };
  const tree = parseC(text);
  let definition = false, stub = false, asm = false, conditional = false;
  try {
    if (tree.rootNode.hasError) return { path, status: "unresolved", sha256, reason: "C parse errors; source is protected" };
    walk(tree.rootNode, n => {
      if (n.type === "preproc_if" && n.childForFieldName("condition")?.text.trim() === "0") {
        // Even a disabled #if 0 can have an active #else. Do not guess which
        // symbol owns the active source in a conditional function fragment.
        if (n.namedChildren.some(c => c.type === "preproc_else" || c.type === "preproc_elif")) conditional = true;
        return false;
      }
      if (["preproc_if", "preproc_ifdef"].includes(n.type)) { conditional = true; return false; }
      if (n.type === "function_definition" && declaratorName(n.childForFieldName("declarator") ?? undefined)?.text === symbol) definition = true;
      if (n.type === "gnu_asm_expression") asm = true;
      if (n.type === "call_expression" && n.childForFieldName("function")?.text === "INCLUDE_ASM") {
        const args = n.childForFieldName("arguments")?.namedChildren ?? [];
        if (args.some(a => a.type === "identifier" && a.text === symbol)) stub = true;
      }
      return true;
    });
  } finally { tree.delete(); }
  if (definition) return { path, status: "C", sha256 };
  if (conditional) return { path, status: "unresolved", sha256, reason: "Conditional source ownership was not preprocessed; source is protected" };
  if (stub) return { path, status: "INCLUDE_ASM", sha256 };
  return { path, status: "unresolved", sha256, reason: asm ? "Existing assembly embedded in C is protected" : "No direct definition or canonical placeholder for this symbol" };
}

function normalizeStorage(reference: string, addend: number, object: ReturnType<typeof libraryMemberById>["object"]) {
  const local = /^(.*)@(\d+)$/.exec(reference);
  if (local) return { reference: `section:${local[1]}`, addend: Number(local[2]) + addend };
  const symbol = object.symbols.find(s => `named:${s.name}` === reference);
  return symbol && object.sections.has(symbol.section) ? { reference: `section:${symbol.section}`, addend: symbol.value + addend } : { reference, addend };
}
/** Reuse the original, text-bounded loader. ET_REL address facts are augmented
 * from the actual object's paired relocations, never from rendered operands. */
function originalFunctions(): { functions: HandwrittenFunction[]; findings: CensusFinding[]; ownerCounts: Map<string, number> } {
  const library = loadLibraryProject(), containers = library ? [] : loadContainers();
  const loaded = loadMacroFunctions(containers);
  if (!library) for (const member of unresolvedCodeMembers()) loaded.findings.push({ container: member.id, function: null, reason: "Unresolved code member was not scanned" });
  const ownerCounts = new Map<string, number>();
  const functions = loaded.functions.map(fn => {
    const owner = library ? fn.container : JSON.stringify([fn.container, resolveFunctionTarget(fn.name).translationUnit.source]);
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    if (!library) return fn;
    const { object } = libraryMemberById(fn.container), references = new Map<number, { reference: string; addend: number }>();
    const start = fn.coordinate!.offset, end = start + fn.bytes.length;
    for (const r of object.relocations) if (r.section === fn.coordinate!.section && r.offset >= start && r.offset < end && [5, 6, 7].includes(r.type))
      references.set((r.offset - start) / 4, normalizeStorage(r.reference, relocatableAddend(object, r), object));
    return { ...fn, storageReferences: references };
  });
  return { functions, findings: loaded.findings, ownerCounts };
}

export function scanHandwrittenAssembly(options: AssemblyScanOptions = {}): AssemblyScanReport {
  // Validate before reading assets or allocating report artifacts.
  const threshold = options.threshold ?? 80;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error("Assembly threshold must be an integer in 1..100");
  return withLibraryMetadata(() => {
    const root = projectRoot(), library = loadLibraryProject(), loaded = originalFunctions(), config = loadToolchain();
    const names = new Set((options.functionNames ?? []).map(name => library ? requireLibraryFunction(name).key : name));
    const owners = new Set(loaded.functions.map(fn => fn.container));
    for (const id of options.containerIds ?? []) if (!owners.has(id)) throw new Error(`Unknown or unscannable container: ${id}`);
    for (const name of names) if (!loaded.functions.some(fn => fn.name === name)) throw new Error(`Unknown function: ${name}`);
    const selected = loaded.functions.filter(fn => (!names.size || names.has(fn.name)) && (!options.containerIds?.length || options.containerIds.includes(fn.container)));
    if ((names.size || options.containerIds?.length) && !selected.length) throw new Error("Function/container filters select no functions");
    const findings = loaded.findings.filter(f => (!options.containerIds?.length || options.containerIds.includes(f.container)) && (!names.size || f.function === null || names.has(f.function)));
    // A selected function can depend on original-word witnesses elsewhere in
    // its owner. Analyze that cohort before filtering the displayed rows.
    const readings = new Map<string, HandwrittenReading>();
    const cohorts = new Map<string, HandwrittenFunction[]>(), ownerKeys = new Map<HandwrittenFunction, string>();
    for (const fn of loaded.functions) {
      const owner = JSON.stringify([fn.container, library ? fn.container : resolveFunctionTarget(fn.name).translationUnit.source]);
      ownerKeys.set(fn, owner);
      const cohort = cohorts.get(owner) ?? []; cohort.push(fn); cohorts.set(owner, cohort);
    }
    const ownerOf = (fn: HandwrittenFunction) => ownerKeys.get(fn)!;
    for (const owner of new Set(selected.map(ownerOf)))
      for (const reading of analyzeHandwrittenModule(cohorts.get(owner)!, { threshold }))
        readings.set(JSON.stringify([owner, reading.function]), reading);
    const rows = selected.map(fn => {
      const target = resolveFunctionTarget(fn.name), reading = readings.get(JSON.stringify([ownerOf(fn), fn.name]))!;
      const source = assemblySourceStatus(target.source, target.symbol), protectedC = source.status === "C", assembly = source.status === "assembly";
      const eligibleForAssembly = reading.assemblyCandidate && !protectedC && !assembly && source.status !== "unresolved";
      const member = library ? libraryMemberById(fn.container) : undefined;
      const row: AssemblyScanRow = { ...reading, source, eligibleForAssembly,
        disposition: protectedC ? "keep-existing-C" : assembly ? "already-assembly" : source.status === "unresolved" ? "source-unresolved" : eligibleForAssembly ? "assembly-candidate" : reading.confidence.score >= 40 ? "inspect" : "continue-C",
        owner: { source: target.translationUnit.source, ...(member ? { input: member.input, member: member.member, sha256: member.sha256 } : {}) } };
      return row;
    }).sort((a, b) => b.confidence.score - a.confidence.score || a.function.localeCompare(b.function));
    const contexts = [...new Set(rows.map(r => r.container))].sort().map(id => {
      const context = library ? libraryContext(id) : loadContainers().find(c => c.id === id)!;
      return { container: id, cc1: configuredFlags("cc1", context), assembler: configuredFlags("as", context) };
    });
    const modules = [...new Set(rows.map(r => JSON.stringify([r.container, r.owner.source])))].sort().map(key => {
      const [container, source] = JSON.parse(key) as [string, string];
      const members = rows.filter(r => r.container === container && r.owner.source === source);
      const allFunctionsScanned = members.length === loaded.ownerCounts.get(library ? container : key) &&
        !loaded.findings.some(f => f.container === container && !f.reason.startsWith("Symbol extent inferred"));
      return { container, source, functions: members.map(r => r.function), candidates: members.filter(r => r.eligibleForAssembly).map(r => r.function),
        existingC: members.filter(r => r.source.status === "C").map(r => r.function), allFunctionsScanned,
        wholeAssemblyCandidate: !!library && allFunctionsScanned && members.every(r => r.eligibleForAssembly) };
    });
    return { schemaVersion: 1, scannerVersion: 4, architecture: "MIPS-I/R3000",
      scope: names.size ? "selected-functions" : options.containerIds?.length ? "selected-containers" : "project",
      // Inferred sizes remain visible limitations, not absent code. Other
      // inventory findings mean the declared census cannot be exhaustive.
      complete: !findings.some(f => !f.reason.startsWith("Symbol extent inferred")), threshold,
      toolchain: { sha256: digest(readFileSync(join(root, "toolchain.json"))), compiler: { family: config.compiler.family, version: config.compiler.version }, configuredNotIdentified: true },
      contexts, findings, functions: rows, modules,
      summary: { scanned: rows.length, high: rows.filter(r => r.confidence.level === "high").length, medium: rows.filter(r => r.confidence.level === "medium").length,
        low: rows.filter(r => r.confidence.level === "low").length, undetermined: rows.filter(r => r.confidence.level === "undetermined").length,
        existingC: rows.filter(r => r.source.status === "C").length, assemblyCandidates: rows.filter(r => r.eligibleForAssembly).length, incompleteAnalyses: rows.filter(r => !r.analysis.complete).length },
      limitations: ["Scores are heuristic support, not calibrated probabilities or proof of historical source language.",
        "C with inline assembly or SDK operation macros can share these original words; hardware operations alone cannot nominate a function.",
        "The configured compiler is recorded, not identified from these bytes; no compiler-emission impossibility is asserted.",
        "Existing C is protected without claiming a fresh byte match. This scanner runs no compiler or byte oracle.",
        "Candidates are advisory. This scanner emits no .s source, grants no exception and changes no classification, build, prompt or progress state.",
        "Module suggestions preserve original ownership; mixed C/assembly members need explicit build support and whole-member verification before conversion."] };
  });
}

export interface ScanArguments extends AssemblyScanOptions { json: boolean; all: boolean; limit: number; output?: string; help: boolean }
export function parseAssemblyScanArguments(args: readonly string[]): ScanArguments {
  const result: ScanArguments = { json: false, all: false, limit: 50, help: false, functionNames: [], containerIds: [] };
  const functions: string[] = [], containers: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const flag = args[at]!;
    if (["--json", "--all", "--help"].includes(flag)) { if (flag === "--json") result.json = true; if (flag === "--all") result.all = true; if (flag === "--help") result.help = true; continue; }
    if (!["--function", "--container", "--threshold", "--limit", "--output"].includes(flag)) throw new Error(`Unknown scanner argument: ${flag}`);
    const value = args[++at];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--function") functions.push(value);
    else if (flag === "--container") containers.push(value);
    else if (flag === "--output") result.output = value;
    else {
      const n = Number(value), maximum = flag === "--threshold" ? 100 : 1_000_000;
      if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > maximum) throw new Error(`${flag} must be an integer in 1..${maximum}`);
      if (flag === "--threshold") result.threshold = n; else result.limit = n;
    }
  }
  result.functionNames = functions; result.containerIds = containers;
  return result;
}
export function renderAssemblyScan(report: AssemblyScanReport, options: { all?: boolean; limit?: number; selected?: boolean } = {}): string {
  const s = report.summary;
  const lines = [`Handwritten assembly heuristics — ${s.scanned} original functions (${report.scope}; census ${report.complete ? "complete" : "incomplete"})`,
    `High ${s.high}, medium ${s.medium}, low ${s.low}, undetermined ${s.undetermined}; ${s.assemblyCandidates} eligible candidates at threshold ${report.threshold}/100`,
    `${s.existingC} existing C sources protected; ${s.incompleteAnalyses} incomplete control/register analyses`,
    "Scores are heuristics, not probabilities. No source, policy or build changes.", ""];
  const chosen = report.functions.filter(r => options.all || options.selected || r.confidence.score >= 40), limit = options.limit ?? 50;
  for (const r of chosen.slice(0, limit)) {
    lines.push(`${String(r.confidence.score).padStart(3)}/100 ${r.confidence.level.padEnd(12)} ${r.function} — ${r.disposition}`);
    lines.push(`  ${r.source.path}; ${r.coordinate.kind === "section" ? `${r.coordinate.section}+0x${r.coordinate.offset.toString(16)}` : `VRAM 0x${r.coordinate.vram.toString(16)}`}; ${r.analysis.reachableWords}/${r.analysis.totalWords} words reachable`);
    for (const signal of r.signals) {
      lines.push(`  ${signal.weight >= 0 ? "+" : ""}${signal.weight} ${signal.id}: ${signal.description}`);
      if (options.selected) for (const e of signal.evidence.slice(0, 6)) lines.push(`    +0x${e.offset.toString(16)} ${e.word} ${e.instruction}${e.storage ? ` [${e.storage}]` : ""}`);
    }
    for (const copy of r.embeddedCopies) {
      lines.push(`  embedded +0x${copy.source.offset.toString(16)}..+0x${(copy.source.offset + copy.source.size).toString(16)}: ${copy.loop.iterations} copied words; ${copy.interpretation} (not directly executed)`);
      if (options.selected) for (const e of copy.evidence.slice(0, 8)) lines.push(`    +0x${e.offset.toString(16)} ${e.word} ${e.instruction} [copied payload]`);
      if (options.selected && copy.evidence.length > 8) lines.push(`    Showing 8 of ${copy.evidence.length} payload words; JSON retains all.`);
    }
    for (const hook of r.codeHooks) {
      lines.push(`  code hook (${hook.role}): save ${hook.save.bytes}, install ${hook.install.bytes}, restore ${hook.restore.bytes} bytes through the same cached pointer`);
      lines.push(`    buffer ${hook.buffer.function}+0x${hook.buffer.offset.toString(16)}; trampoline ${hook.trampoline.function}+0x${hook.trampoline.offset.toString(16)} -> ${hook.trampoline.target}`);
      if (options.selected) for (const w of hook.witnesses) lines.push(`    witness ${w.function}; original ${w.originalSha256}`);
    }
    for (const transfer of r.copiedTransfers) {
      const t = transfer.template, target = transfer.target;
      lines.push(`  copied transfer: ${t.copiedBytes} bytes from ${t.function}+0x${t.offset.toString(16)}; delay slot ${t.delaySlotCopied ? "copied" : "NOT copied (destination slot unknown)"}`);
      lines.push(`    ${target.kind} ${target.function}+0x${target.offset.toString(16)}${target.kind === "local-entry" ? `; ${target.reachableWords} words traced, ${target.exceptionReturns.length} exception returns` : `; RAM 0x${target.address.toString(16)} (physical 0x${target.physicalAddress.toString(16)}), deployed by ${target.deployment.copy.function}`}`);
      if (options.selected) for (const w of transfer.witnesses) lines.push(`    witness ${w.function}; original ${w.originalSha256}`);
    }
    if (r.signals.filter(s => s.family === "code-patching").length > 1) lines.push("  note: code-patching observations contribute at most +20 combined (not additive)");
    for (const limitation of r.analysis.limitations) lines.push(`  note: ${limitation}`);
  }
  if (chosen.length > limit) lines.push(`Showing ${limit} of ${chosen.length} qualifying rows; JSON retains all ${s.scanned} scanned functions.`);
  if (!chosen.length) lines.push("No rows at the display floor (40); use --all or --function KEY.");
  return lines.join("\n") + "\n";
}
function main() {
  const args = parseAssemblyScanArguments(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: handwrittenAssembly.ts [--function KEY ...] [--container ID ...] [--threshold 1..100] [--json] [--all] [--limit N] [--output build/FILE.json]\nScans original, text-bounded MIPS I code with symbolic relocations. Default threshold 80; existing C is protected. --all affects display only. No compiler runs, source emission or policy changes.");
    return;
  }
  let output: string | undefined;
  if (args.output) {
    output = resolve(projectRoot(), args.output);
    const rel = relative(resolve(projectRoot(), "build"), output);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || !output.endsWith(".json")) throw new Error("Scanner report output must be a JSON file inside the project's build/ directory");
    for (let path = output; path !== projectRoot(); path = dirname(path))
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Scanner report output must not traverse symlinks");
  }
  const report = scanHandwrittenAssembly(args), text = JSON.stringify(report, null, 2) + "\n";
  if (output) writeIfChanged(output, text);
  process.stdout.write(args.json ? text : renderAssemblyScan(report, { all: args.all, limit: args.limit, selected: !!args.functionNames?.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
