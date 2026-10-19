/** Ordered source fragments are ONE production compiler TU, never isolated
 * objects joined after matching. The manifest contains no compiler flags. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { LibraryMember } from "./libraryTargets.js";
import { assertAssemblySource } from "./assemblyPolicy.js";
import { libraryAssemblyInputs } from "./libraryAssembly.js";
import { scanDependencies, dependencyPaths } from "./dependencyScanner.js";
import { configuredAssemblyCppFlags, configuredFlags, type FlagContext } from "./toolchain.js";
import { analyzeCSource, walkActiveC } from "../agent/cSourceAnalysis.js";
import { activeSourceText } from "./disabledSource.js";
import { extractSignaturesFromSource } from "../agent/sdkTypes.js";
import { parseC } from "../agent/residual-source-search/tree-sitter-c.js";
import { digest as fileTextDigest, fileDigest, invocationMemo, writeIfChanged } from "./contentCache.js";
import { classifyLibraryCode } from "../agent/libraryCodeClass.js";
import { projectRoot } from "./runtimeContext.js";
import { count } from "./perfCounters.js";

/** A C part defines one function (`symbol`) or shared declarations/data. An
 * assembly part is the member's ONE `.s` source and lists every original
 * function it defines (`symbols`): the faithful form for members whose
 * original was hand-written assembly. A TU is either C parts or one `.s`. */
export interface RetainedHandwrittenAssembly {
  kind: "original-extraction";
  originalSha256: string;
  format: "assembler-with-cpp";
  assembly: { path: string; sha256: string };
  declarations: { path: string; sha256: string };
}
/** A hand-written function inside a C member (an `asm()` body in the original C
 * file). Its part stays the canonical INCLUDE_ASM extraction and is never a C
 * target. `evidence` is the classifier's verdict, recomputed on every read, so a
 * stale or hand-made flag fails closed. */
export interface RetainedHandwrittenFunction {
  kind: "handwritten-assembly";
  evidence: string;
  originalSha256: string;
}
/** A folded module is a C part listing every function it defines (`symbols`),
 * the TU's only part. Its retained hand-written functions stay their canonical
 * INCLUDE_ASM lines inside it, recorded in `retainedFunctions`. */
export interface LibraryTuPart { path: string; symbol?: string; symbols?: string[]; backlog?: true; handwritten?: RetainedHandwrittenAssembly; retained?: RetainedHandwrittenFunction;
  retainedFunctions?: Record<string, RetainedHandwrittenFunction>;
  /** SHA-256 of the module text that passed the agent cleanup and its gate. */
  cleanedSha256?: string }
export interface LibraryTuManifest { schemaVersion: 1; member: string; parts: LibraryTuPart[] }
export type LibraryTuForm = "c" | "assembly";
export const isLibraryGeneratedSymbol = (symbol: string | undefined) => symbol === "__library_member_data" || symbol === "__library_member_symbols";
/** The reserved part of each generated symbol, and its finishing-target pseudo-function. */
export const LIBRARY_GENERATED_PARTS = { __library_member_data: "_data.c", __library_member_symbols: "_symbols.c" } as const;
export const libraryGeneratedFunction = (symbol: keyof typeof LIBRARY_GENERATED_PARTS) =>
  ({ name: symbol, section: "", offset: 0, size: 0, inferredSize: false, generated: symbol === "__library_member_data" ? "data" as const : "symbols" as const });
export const isDirectoryTu = (member: LibraryMember) => member.source.endsWith("/tu.json");
export const libraryOriginalSha256 = (member: LibraryMember) => member.originalObject?.sha256 ?? member.sha256;
export const isAssemblyPart = (part: LibraryTuPart) => part.path.endsWith(".s") || part.path.endsWith(".ASM");
export const isModulePart = (part: LibraryTuPart) => part.path.endsWith(".c") && Array.isArray(part.symbols);
export const libraryTuPartSymbols = (part: LibraryTuPart): string[] => part.symbols ?? (part.symbol ? [part.symbol] : []);
export interface LibraryAssemblyTu { part: LibraryTuPart; source: string; symbols: string[] }
/** The assembly source of an assembly TU (absolute path), or undefined for a
 * C TU, a legacy monolithic member or a member that has not been split yet. */
export function libraryAssemblyTu(member: LibraryMember, root: string): LibraryAssemblyTu | undefined {
  if (!isDirectoryTu(member) || !existsSync(resolve(root, member.source))) return undefined;
  const part = readLibraryTu(member, root, { allowDiscoveredBacklog: true }).parts.find(isAssemblyPart);
  return part ? { part, source: resolve(root, dirname(member.source), part.path), symbols: part.symbols! } : undefined;
}
/** Every file the assembler reads for an assembly TU: the source and its
 * transitive `.include`s under the configured include directories. */
export function libraryAssemblyInput(tu: LibraryAssemblyTu, outputDirectory: string): string {
  if (!tu.part.handwritten) return tu.source;
  const input = join(outputDirectory, "handwritten-input.ASM");
  const paths = [tu.part.handwritten.declarations, tu.part.handwritten.assembly].map(f => {
    const path = resolve(dirname(tu.source), f.path);
    if (fileDigest(path) !== f.sha256) throw new Error(`Changed retained handwritten extraction: ${f.path}`);
    return path;
  });
  mkdirSync(outputDirectory, { recursive: true });
  writeIfChanged(input, paths.map(p => `#include ${JSON.stringify(p)}\n`).join(""));
  return input;
}
/** `scan` answers `-M -MG` for one input; callers with a validated cache pass it. */
export function libraryAssemblyDependencies(tu: LibraryAssemblyTu, context: FlagContext, root: string,
  scan: (input: string, flags: string[]) => string[] = (input, flags) => dependencyPaths(scanDependencies(input, flags, root), root)): string[] {
  const asFlags = configuredFlags("as", context, root);
  const directories = asFlags.flatMap((f, i) => f === "-I" ? [asFlags[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []).concat(root);
  const input = libraryAssemblyInput(tu, join(root, "build/libraries/drivers", context.id ?? "assembly"));
  const files: string[] = tu.source.endsWith(".ASM") ? scan(input, configuredAssemblyCppFlags(context, root)).filter(p => p !== input || input === tu.source) : [];
  const pending = [tu.source], visited = new Set<string>();
  while (pending.length) {
    const file = pending.shift()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    if (!files.includes(file)) files.push(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*\.include\s+"([^"]+)"/gm)) {
      const found = directories.map(d => resolve(d, match[1]!)).find(existsSync);
      if (found) pending.push(found);
    }
  }
  return files;
}
export function libraryFunctionFilename(member: LibraryMember, symbol: string): string {
  if (isLibraryGeneratedSymbol(symbol)) return LIBRARY_GENERATED_PARTS[symbol as keyof typeof LIBRARY_GENERATED_PARTS];
  const original = member.functions.filter(fn => !fn.discovery);
  if (member.object) original.sort((a, b) => member.object.symbols.findIndex(s => s.name === a.name) - member.object.symbols.findIndex(s => s.name === b.name));
  const fn = member.functions.find(fn => fn.name === symbol);
  // Newly recovered entries must not renumber existing case-distinct source
  // files. Original symbol-TABLE ordinals (not address order) retain the
  // established path contract even when the function inventory is sorted.
  if (fn?.discovery) {
    const collision = member.functions.filter(f => f.name.toLowerCase() === symbol.toLowerCase()).length > 1;
    const prefix = collision ? `private-${(member.viewObject ?? member.object).sections.get(fn.section)!.index}-${fn.offset.toString(16)}-` : "";
    return `${prefix}${symbol}.c`;
  }
  const collision = original.filter(fn => fn.name.toLowerCase() === symbol.toLowerCase()).length > 1;
  return `${collision ? `${original.findIndex(fn => fn.name === symbol)}-` : ""}${symbol}.c`;
}
/** The file defining `symbol`: its own part, or the folded module that lists it. */
export function libraryFunctionSource(member: LibraryMember, symbol: string, root = projectRoot()): string {
  if (!isDirectoryTu(member)) return member.source;
  const derived = join(dirname(member.source), libraryFunctionFilename(member, symbol)).replaceAll("\\", "/");
  if (existsSync(resolve(root, derived)) || !existsSync(resolve(root, member.source))) return derived;
  const module = readLibraryTu(member, root).parts.find(p => isModulePart(p) && p.symbols!.includes(symbol));
  return module ? join(dirname(member.source), module.path).replaceAll("\\", "/") : derived;
}
export const libraryModulePart = (member: LibraryMember, root: string): LibraryTuPart | undefined =>
  isDirectoryTu(member) && existsSync(resolve(root, member.source)) ? readLibraryTu(member, root).parts.find(isModulePart) : undefined;
export function readLibraryTu(member: LibraryMember, root: string, options: { allowDiscoveredBacklog?: boolean } = {}): LibraryTuManifest {
  const text = readFileSync(resolve(root, member.source), "utf8");
  // The same text for the same member validates the same way: once per invocation.
  invocationMemo(`library-tu\0${resolve(root)}\0${member.id}\0${member.sha256}\0${options.allowDiscoveredBacklog === true}\0${text}`,
    () => validateLibraryTu(JSON.parse(text) as LibraryTuManifest, member, root, options));
  return JSON.parse(text) as LibraryTuManifest;
}
function validateLibraryTu(manifest: LibraryTuManifest, member: LibraryMember, root: string, options: { allowDiscoveredBacklog?: boolean }): true {
  if (manifest.schemaVersion !== 1 || manifest.member !== member.id || !Array.isArray(manifest.parts) || !manifest.parts.length ||
      Object.keys(manifest).some(k => !["schemaVersion", "member", "parts"].includes(k))) throw new Error(`Invalid TU manifest: ${member.source}`);
  const paths = new Set<string>(), symbols = new Set<string>();
  const directory = realpathSync.native(resolve(root, dirname(member.source)));
  for (const part of manifest.parts) {
    if (!part || typeof part.path !== "string" || !/^[A-Za-z_0-9][A-Za-z_0-9.-]*\.(?:[chs]|ASM)$/.test(part.path) || paths.has(part.path.toLowerCase()) ||
        Object.keys(part).some(k => !["path", ...(isAssemblyPart(part) ? ["symbols", "backlog", "handwritten"] : isModulePart(part) ? ["symbols", "retainedFunctions", "cleanedSha256"] : ["symbol", "retained"])].includes(k)) || (part.backlog !== undefined && part.backlog !== true)) throw new Error(`Invalid/duplicate TU part: ${member.source}`);
    paths.add(part.path.toLowerCase());
    if (dirname(realpathSync.native(resolve(directory, part.path))) !== directory) throw new Error(`TU part escapes its directory: ${part.path}`);
    if (isAssemblyPart(part)) {
      // One original object, one hand-written source: no C neighbors, no data stub.
      if (manifest.parts.length !== 1 || !Array.isArray(part.symbols) || (!part.symbols.length && member.functions.length > 0)) throw new Error(`An assembly TU is one .s part listing every original function: ${member.source}`);
      if (part.handwritten) {
        const h = part.handwritten;
        if (!part.backlog || h.kind !== "original-extraction" || h.format !== "assembler-with-cpp" || !member.originalObject || h.originalSha256 !== member.originalObject.sha256 ||
            Object.keys(h).some(k => !["kind", "originalSha256", "format", "assembly", "declarations"].includes(k))) throw new Error(`${part.path}: invalid handwritten extraction provenance`);
        for (const f of [h.assembly, h.declarations]) {
          if (!f || !/^[A-Za-z_0-9][A-Za-z_0-9.-]*\.ASM$/.test(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || Object.keys(f).some(k => !["path", "sha256"].includes(k)) ||
              dirname(realpathSync.native(resolve(directory, f.path))) !== directory) throw new Error(`${part.path}: invalid handwritten extraction file`);
        }
        if (h.assembly.path !== part.path || h.assembly.path === h.declarations.path) throw new Error(`${part.path}: invalid handwritten assembly/declaration paths`);
      }
      for (const symbol of part.symbols) {
        if (typeof symbol !== "string" || !/^[A-Za-z_]\w*$/.test(symbol) || symbols.has(symbol)) throw new Error(`Invalid/duplicate TU symbol: ${symbol}`);
        symbols.add(symbol);
      }
    }
    if (isModulePart(part)) {
      if (manifest.parts.length !== 1) throw new Error(`A folded module is its TU's only part: ${member.source}`);
      if (part.cleanedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(part.cleanedSha256)) throw new Error(`${part.path}: invalid cleanup marker`);
      for (const symbol of part.symbols!) {
        if (typeof symbol !== "string" || !/^[A-Za-z_]\w*$/.test(symbol) || symbols.has(symbol) || isLibraryGeneratedSymbol(symbol)) throw new Error(`Invalid/duplicate module symbol: ${symbol}`);
        symbols.add(symbol);
      }
      for (const [symbol, retained] of Object.entries(part.retainedFunctions ?? {})) {
        if (!part.symbols!.includes(symbol)) throw new Error(`${part.path}: retained ${symbol} is not a module symbol`);
        validateRetainedFunction({ path: part.path, symbol, retained }, member);
      }
    }
    if (part.symbol !== undefined) {
      if (!/^[A-Za-z_]\w*$/.test(part.symbol) || symbols.has(part.symbol)) throw new Error(`Invalid/duplicate TU symbol: ${part.symbol}`);
      symbols.add(part.symbol);
      if (!isLibraryGeneratedSymbol(part.symbol) && part.path !== libraryFunctionFilename(member, part.symbol)) throw new Error(`Function TU part must be ${libraryFunctionFilename(member, part.symbol)}`);
    }
    if (part.retained !== undefined) validateRetainedFunction(part, member);
  }
  if (member.functions.some(fn => !symbols.has(fn.name) && !(options.allowDiscoveredBacklog && fn.discovery !== undefined)) || [...symbols].some(s => !isLibraryGeneratedSymbol(s) && !member.functions.some(fn => fn.name === s)))
    throw new Error(`TU manifest must list every original function exactly once: ${member.source}`);
  return true;
}
function validateRetainedFunction(part: LibraryTuPart, member: LibraryMember): void {
  const r = part.retained!, fn = member.functions.find(f => f.name === part.symbol);
  if (!fn || !r || typeof r !== "object" || Object.keys(r).some(k => !["kind", "evidence", "originalSha256"].includes(k)) ||
      r.kind !== "handwritten-assembly" || r.originalSha256 !== libraryOriginalSha256(member)) throw new Error(`${part.path}: invalid retained hand-written function`);
  const evidence = classifyLibraryCode(member.object, fn)?.kind;
  if (r.evidence !== evidence) throw new Error(`${part.path}: retained evidence ${r.evidence} disagrees with the original words (${evidence ?? "no hand-written fingerprint"})`);
}
export function librarySourceFiles(member: LibraryMember, root: string): string[] {
  return isDirectoryTu(member) ? [...new Set([member.source, ...readLibraryTu(member, root).parts.flatMap(p => [p.path, ...(p.handwritten ? [p.handwritten.declarations.path] : [])]).map(p => join(dirname(member.source), p))])] : [member.source];
}
/** Members whose TU reads one of `files`. Every source of a TU sits beside its
 * owner (parts are bare filenames), so only members in a directory holding one
 * of the files are opened. */
export function libraryMembersOwning(members: readonly LibraryMember[], files: readonly string[], root: string): LibraryMember[] {
  const directories = new Set(files.map(file => dirname(file)));
  return members.filter(m => directories.has(dirname(m.source)) && librarySourceFiles(m, root).some(s => files.includes(s)));
}
const escapePattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An assembly part is reconstructed source, not a disassembler listing: no
 * backlog markers, explicit relocation tables, byte blobs or path includes.
 * It must define every function it claims; binding is the object oracle's job. */
function inspectAssemblyPart(text: string, part: LibraryTuPart): { stub: boolean } {
  if (part.handwritten) {
    if (!part.backlog || part.handwritten.format !== "assembler-with-cpp" || fileTextDigest(text) !== part.handwritten.assembly.sha256)
      throw new Error(`${part.path}: changed retained handwritten extraction`);
    return { stub: true };
  }
  if (part.path.endsWith(".ASM")) text = activeSourceText(text);
  const generated = [...text.matchAll(/^\s*\.include\s+"(build\/libraries\/nonmatchings\/[^"\n]+\.s)"\s*$/gm)];
  if (part.backlog) {
    if (generated.length !== 2 || !generated.some(m => m[1]!.endsWith("/__library_member_assembly.s")) || text.replace(/^\s*\.include[^\n]*$/gm, "").replace(/\/\*[^]*?\*\//g, "").trim()) throw new Error(`${part.path}: assembly backlog must include its generated listings only`);
    return { stub: true };
  }
  assertAssemblySource(text, part.path);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\*.*?\*\//g, "").replace(/#.*$/, "").trim();
    if (!line) continue;
    const include = /^\.?include\b\s*(.*)$/.exec(line);
    if (include && !/^"[\w.-]+\.inc"$/.test(include[1]!) && !/^"build\/libraries\/nonmatchings\/[\w-]+\/__library_member_symbols\.s"$/.test(include[1]!)) throw new Error(`${part.path}: assembly parts include only bare macro files from the configured include directories: ${raw.trim()}`);
    const directive = /^\.(incbin|reloc)\b/.exec(line);
    if (directive) throw new Error(`${part.path}: .${directive[1]} is not reconstructed source`);
    if (/^nonmatching\b/.test(line) || /\bINCLUDE_ASM\b/.test(line) || /\.L__library_rel_/.test(line) || /\.NON_MATCHING\b/.test(line))
      throw new Error(`${part.path}: disassembler backlog markers are not reconstructed source`);
  }
  for (const symbol of libraryTuPartSymbols(part))
    if (!new RegExp(`^\\s*(?:${escapePattern(symbol)}\\s*:|glabel\\s+${escapePattern(symbol)}(?:,|\\s|$))`, "m").test(text)) throw new Error(`${part.path}: must define ${symbol}`);
  return { stub: generated.length > 0 };
}
/** Strict file boundary: a function file is either its sole canonical stub or
 * one definition; shared files cannot hide functions or assembly placeholders.
 * A module needs its `member` to tell named functions from private helpers. */
export function inspectLibraryPart(text: string, part: LibraryTuPart, member?: LibraryMember): { stub: boolean } {
  // A pure function of the part, its text and its member: parsed once per invocation.
  return invocationMemo(`library-part\0${JSON.stringify(part)}\0${member ? `${member.id}\0${member.sha256}` : ""}\0${text}`, () => inspectPart(text, part, member));
}
/** A private helper the original object never named: its target identity is a
 * code coordinate (`func_<offset>`), not a name the object or its links carry. */
export const isUnnamedPrivateFunction = (member: LibraryMember, symbol: string) =>
  member.functions.find(fn => fn.name === symbol)?.discovery !== undefined;
function inspectPart(text: string, part: LibraryTuPart, member?: LibraryMember): { stub: boolean } {
  if (isAssemblyPart(part)) return inspectAssemblyPart(text, part);
  const guard = analyzeCSource(text);
  if (!guard.parses) throw new Error(`${part.path}: invalid C: ${guard.reasons.join("; ")}`);
  const signatures = extractSignaturesFromSource(text);
  if (isModulePart(part)) {
    const retained = new Set(Object.keys(part.retainedFunctions ?? {})), expected = part.symbols!.filter(s => !retained.has(s));
    // Every function the object names keeps its name. A private helper it never
    // named may take any name; the object hash still requires internal linkage.
    const named = expected.filter(s => !member || !isUnnamedPrivateFunction(member, s));
    const defined = signatures.map(s => s.name), tree = parseC(text);
    let definitions = 0;
    try { walkActiveC(tree.rootNode, node => { if (node.type === "function_definition") definitions++; return true; }); } finally { tree.delete(); }
    if (definitions !== expected.length || new Set(defined).size !== defined.length || defined.length !== expected.length || named.some(s => !defined.includes(s)))
      throw new Error(`${part.path}: a folded module must define exactly its non-retained functions${named.length < expected.length ? `, keeping the object's names (${named.join(", ")}); only private helpers may be renamed` : ""}`);
    const stubs = guard.includeAsm.map(site => site.symbol);
    if (stubs.length !== retained.size || [...retained].some(s => stubs.filter(x => x === s).length !== 1))
      throw new Error(`${part.path}: only retained hand-written functions stay INCLUDE_ASM in a module, each exactly once`);
    return { stub: false };
  }
  if (guard.includeAsm.length) {
    const tree = parseC(text);
    try {
      const code: import("web-tree-sitter").Node[] = [];
      walkActiveC(tree.rootNode, node => {
        if (node.type === "translation_unit" || ["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_else"].includes(node.type)) return true;
        if (!["comment", "preproc_include", "number_literal"].includes(node.type)) code.push(node);
        return false;
      });
      if (!part.symbol || guard.includeAsm.length !== 1 || guard.includeAsm[0]!.symbol !== part.symbol || code.length !== 1 ||
          code[0]!.type !== "expression_statement" || signatures.length) throw new Error(`${part.path}: mixed/partial stub source is forbidden`);
    } finally { tree.delete(); }
    return { stub: true };
  }
  if (part.symbol && !isLibraryGeneratedSymbol(part.symbol)) {
    if (signatures.length !== 1 || signatures[0]!.name !== part.symbol) throw new Error(`${part.path}: must define only ${part.symbol}`);
    const tree = parseC(text);
    try {
      let definitions = 0;
      walkActiveC(tree.rootNode, node => { if (node.type === "function_definition") definitions++; return true; });
      if (definitions > 1)
        throw new Error(`${part.path}: nested function definitions are not C89 function fragments`);
    } finally { tree.delete(); }
  } else if (signatures.length) throw new Error(`${part.path}: shared/data part cannot define functions`);
  return { stub: false };
}
/** `retained` marks a stub that is final: original-derived hand-written assembly,
 * never a C target (a retained function part, or a retained assembly extraction). */
export interface LibraryTuPartStatus { path: string; symbol?: string; source: string; stub: boolean; form: LibraryTuForm; retained?: string }
/** One row per C part; one row per function of an assembly part. */
export function libraryTuStatus(member: LibraryMember, root: string, replacement?: { symbol: string; source: string }): LibraryTuPartStatus[] | undefined {
  if (!isDirectoryTu(member)) return undefined;
  count("tu.status");
  return readLibraryTu(member, root).parts.flatMap((part): LibraryTuPartStatus[] => {
    if (isAssemblyPart(part)) {
      if (replacement) throw new Error(`${member.id} is an assembly translation unit; C candidates do not apply`);
      const path = resolve(root, dirname(member.source), part.path), status = inspectLibraryPart(readFileSync(path, "utf8"), part);
      if (part.handwritten) {
        for (const f of [part.handwritten.declarations, part.handwritten.assembly]) {
          if (fileDigest(resolve(root, dirname(member.source), f.path)) !== f.sha256) throw new Error(`${member.id}: changed retained handwritten extraction: ${f.path}`);
        }
      }
      return (part.symbols!.length ? part.symbols! : [undefined]).map(symbol => ({ path: part.path, ...(symbol === undefined ? {} : { symbol }), source: path, ...status, form: "assembly" as const,
        ...(part.handwritten ? { retained: part.handwritten.kind } : {}) }));
    }
    if (isModulePart(part)) {
      const path = resolve(root, dirname(member.source), part.path);
      // Measuring the live module is no substitution; any other candidate is.
      if (replacement && resolve(root, replacement.source) !== path) throw new Error(`${member.id} is a folded module; a candidate replaces the whole module`);
      const text = readFileSync(path, "utf8");
      inspectLibraryPart(text, part, member);
      if (analyzeCSource(text).includeAsm.some(site => site.folder !== `build/libraries/nonmatchings/${member.id}`)) throw new Error(`${part.path}: retained functions must reference this member's original assembly`);
      return part.symbols!.map(symbol => {
        const retained = part.retainedFunctions?.[symbol];
        return { path: part.path, symbol, source: path, stub: retained !== undefined, form: "c" as const, ...(retained ? { retained: retained.evidence } : {}) };
      });
    }
    const path = replacement && replacement.symbol === part.symbol ? resolve(root, replacement.source) : resolve(root, dirname(member.source), part.path);
    const text = readFileSync(path, "utf8"), status = inspectLibraryPart(text, part);
    if (status.stub && analyzeCSource(text).includeAsm[0]!.folder !== `build/libraries/nonmatchings/${member.id}`) throw new Error(`${part.path}: backlog must reference this member's original assembly`);
    if (part.retained && !status.stub) throw new Error(`${part.path}: retained hand-written assembly must stay its original INCLUDE_ASM extraction`);
    return [{ path: part.path, ...(part.symbol !== undefined ? { symbol: part.symbol } : {}), source: path, ...status, form: "c" as const,
      ...(part.retained ? { retained: part.retained.evidence } : {}) }];
  });
}
/** Used by production, every diagnostic compiler and the async preparer. The
 * same ordered include driver substitutes at most ONE function fragment. */
export function libraryCompileInput(member: LibraryMember, source: string, outputDir: string, root: string, symbol?: string): string {
  if (!isDirectoryTu(member)) return source;
  if (libraryAssemblyTu(member, root)) throw new Error(`${member.id} is an assembly translation unit; it is assembled, not preprocessed`);
  const absolute = resolve(root, source), owner = resolve(root, member.source), module = libraryModulePart(member, root);
  if (module && absolute !== owner && absolute !== resolve(root, dirname(member.source), module.path)) throw new Error(`${member.id} is a folded module; a candidate replaces the whole module: ${source}`);
  const whole = absolute === owner || module !== undefined;
  const definitions = whole ? [] : extractSignaturesFromSource(readFileSync(absolute, "utf8")).filter(s => member.functions.some(fn => fn.name === s.name));
  const selected = whole ? undefined : symbol ?? member.functions.find(fn => resolve(root, libraryFunctionSource(member, fn.name, root)) === absolute)?.name ?? (definitions.length === 1 ? definitions[0]!.name : undefined);
  if (!whole && !selected) throw new Error(`A TU candidate must identify one function: ${source}`);
  const status = libraryTuStatus(member, root, whole ? undefined : { symbol: selected!, source: absolute })!;
  for (const part of status.filter(p => p.stub))
    libraryAssemblyInputs(member, part.symbol ?? analyzeCSource(readFileSync(part.source, "utf8")).includeAsm[0]!.symbol, root);
  mkdirSync(outputDir, { recursive: true });
  const driver = join(outputDir, "translation-unit.c");
  // Rewritten only when it changes: readers in other processes never see it half-written.
  writeIfChanged(driver, `/* Generated production TU: ${member.id}. Do not edit. */\n` +
    (status.some(p => p.symbol === "__library_member_symbols") ? '#include "include_asm.h"\n' : "") +
    [...new Set(status.map(p => p.source))].map(source => `#include ${JSON.stringify(source)}\n`).join(""));
  return driver;
}
/** Deterministic driver for dependency scanning; generated files themselves are
 * not inputs. The manifest and every fragment ARE inputs. */
export function libraryDependencyInput(member: LibraryMember, root: string): string {
  return libraryCompileInput(member, resolve(root, member.source), join(root, "build/libraries/drivers", member.id), root);
}
