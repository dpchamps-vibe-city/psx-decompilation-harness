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
import { invocationMemo, writeIfChanged } from "./contentCache.js";

/** A C part defines one function (`symbol`) or shared declarations/data. An
 * assembly part is the member's ONE `.s` source and lists every original
 * function it defines (`symbols`): the faithful form for members whose
 * original was hand-written assembly. A TU is either C parts or one `.s`. */
export interface LibraryTuPart { path: string; symbol?: string; symbols?: string[]; backlog?: true }
export interface LibraryTuManifest { schemaVersion: 1; member: string; parts: LibraryTuPart[] }
export type LibraryTuForm = "c" | "assembly";
export const isLibraryGeneratedSymbol = (symbol: string | undefined) => symbol === "__library_member_data" || symbol === "__library_member_symbols";
export const isDirectoryTu = (member: LibraryMember) => member.source.endsWith("/tu.json");
export const isAssemblyPart = (part: LibraryTuPart) => part.path.endsWith(".s") || part.path.endsWith(".ASM");
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
export function libraryAssemblyDependencies(tu: LibraryAssemblyTu, context: FlagContext, root: string): string[] {
  const asFlags = configuredFlags("as", context, root);
  const directories = asFlags.flatMap((f, i) => f === "-I" ? [asFlags[i + 1]!] : f.startsWith("-I") ? [f.slice(2)] : []).concat(root);
  const files: string[] = tu.source.endsWith(".ASM") ? dependencyPaths(scanDependencies(tu.source, configuredAssemblyCppFlags(context, root), root), root) : [];
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
export function libraryFunctionSource(member: LibraryMember, symbol: string): string {
  return isDirectoryTu(member) ? join(dirname(member.source), libraryFunctionFilename(member, symbol)).replaceAll("\\", "/") : member.source;
}
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
        Object.keys(part).some(k => !["path", ...(isAssemblyPart(part) ? ["symbols", "backlog"] : ["symbol"])].includes(k)) || (part.backlog !== undefined && part.backlog !== true)) throw new Error(`Invalid/duplicate TU part: ${member.source}`);
    paths.add(part.path.toLowerCase());
    if (dirname(realpathSync.native(resolve(directory, part.path))) !== directory) throw new Error(`TU part escapes its directory: ${part.path}`);
    if (isAssemblyPart(part)) {
      // One original object, one hand-written source: no C neighbors, no data stub.
      if (manifest.parts.length !== 1 || !Array.isArray(part.symbols) || (!part.symbols.length && member.functions.length > 0)) throw new Error(`An assembly TU is one .s part listing every original function: ${member.source}`);
      for (const symbol of part.symbols) {
        if (typeof symbol !== "string" || !/^[A-Za-z_]\w*$/.test(symbol) || symbols.has(symbol)) throw new Error(`Invalid/duplicate TU symbol: ${symbol}`);
        symbols.add(symbol);
      }
    }
    if (part.symbol !== undefined) {
      if (!/^[A-Za-z_]\w*$/.test(part.symbol) || symbols.has(part.symbol)) throw new Error(`Invalid/duplicate TU symbol: ${part.symbol}`);
      symbols.add(part.symbol);
      if (!isLibraryGeneratedSymbol(part.symbol) && part.path !== libraryFunctionFilename(member, part.symbol)) throw new Error(`Function TU part must be ${libraryFunctionFilename(member, part.symbol)}`);
    }
  }
  if (member.functions.some(fn => !symbols.has(fn.name) && !(options.allowDiscoveredBacklog && fn.discovery !== undefined)) || [...symbols].some(s => !isLibraryGeneratedSymbol(s) && !member.functions.some(fn => fn.name === s)))
    throw new Error(`TU manifest must list every original function exactly once: ${member.source}`);
  return true;
}
export function librarySourceFiles(member: LibraryMember, root: string): string[] {
  return isDirectoryTu(member) ? [member.source, ...readLibraryTu(member, root).parts.map(p => join(dirname(member.source), p.path))] : [member.source];
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
 * one definition; shared files cannot hide functions or assembly placeholders. */
export function inspectLibraryPart(text: string, part: LibraryTuPart): { stub: boolean } {
  // A pure function of the part and its text: parsed once per invocation.
  return invocationMemo(`library-part\0${JSON.stringify(part)}\0${text}`, () => inspectPart(text, part));
}
function inspectPart(text: string, part: LibraryTuPart): { stub: boolean } {
  if (isAssemblyPart(part)) return inspectAssemblyPart(text, part);
  const guard = analyzeCSource(text);
  if (!guard.parses) throw new Error(`${part.path}: invalid C: ${guard.reasons.join("; ")}`);
  const signatures = extractSignaturesFromSource(text);
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
export interface LibraryTuPartStatus { path: string; symbol?: string; source: string; stub: boolean; form: LibraryTuForm }
/** One row per C part; one row per function of an assembly part. */
export function libraryTuStatus(member: LibraryMember, root: string, replacement?: { symbol: string; source: string }): LibraryTuPartStatus[] | undefined {
  if (!isDirectoryTu(member)) return undefined;
  return readLibraryTu(member, root).parts.flatMap((part): LibraryTuPartStatus[] => {
    if (isAssemblyPart(part)) {
      if (replacement) throw new Error(`${member.id} is an assembly translation unit; C candidates do not apply`);
      const path = resolve(root, dirname(member.source), part.path), status = inspectLibraryPart(readFileSync(path, "utf8"), part);
      return (part.symbols!.length ? part.symbols! : [undefined]).map(symbol => ({ path: part.path, ...(symbol === undefined ? {} : { symbol }), source: path, ...status, form: "assembly" as const }));
    }
    const path = replacement && replacement.symbol === part.symbol ? resolve(root, replacement.source) : resolve(root, dirname(member.source), part.path);
    const text = readFileSync(path, "utf8"), status = inspectLibraryPart(text, part);
    if (status.stub && analyzeCSource(text).includeAsm[0]!.folder !== `build/libraries/nonmatchings/${member.id}`) throw new Error(`${part.path}: backlog must reference this member's original assembly`);
    return [{ path: part.path, ...(part.symbol !== undefined ? { symbol: part.symbol } : {}), source: path, ...status, form: "c" as const }];
  });
}
/** Used by production, every diagnostic compiler and the async preparer. The
 * same ordered include driver substitutes at most ONE function fragment. */
export function libraryCompileInput(member: LibraryMember, source: string, outputDir: string, root: string, symbol?: string): string {
  if (!isDirectoryTu(member)) return source;
  if (libraryAssemblyTu(member, root)) throw new Error(`${member.id} is an assembly translation unit; it is assembled, not preprocessed`);
  const absolute = resolve(root, source), owner = resolve(root, member.source);
  const definitions = absolute === owner ? [] : extractSignaturesFromSource(readFileSync(absolute, "utf8")).filter(s => member.functions.some(fn => fn.name === s.name));
  const selected = symbol ?? member.functions.find(fn => resolve(root, libraryFunctionSource(member, fn.name)) === absolute)?.name ?? (definitions.length === 1 ? definitions[0]!.name : undefined);
  if (absolute !== owner && !selected) throw new Error(`A TU candidate must identify one function: ${source}`);
  const status = libraryTuStatus(member, root, absolute === owner ? undefined : { symbol: selected!, source: absolute })!;
  for (const part of status.filter(p => p.stub)) {
    const stub = analyzeCSource(readFileSync(part.source, "utf8")).includeAsm[0]!;
    libraryAssemblyInputs(member, stub.symbol, root);
  }
  mkdirSync(outputDir, { recursive: true });
  const driver = join(outputDir, "translation-unit.c");
  // Rewritten only when it changes: readers in other processes never see it half-written.
  writeIfChanged(driver, `/* Generated production TU: ${member.id}. Do not edit. */\n` +
    (status.some(p => p.symbol === "__library_member_symbols") ? '#include "include_asm.h"\n' : "") +
    status.map(p => `#include ${JSON.stringify(p.source)}\n`).join(""));
  return driver;
}
/** Deterministic driver for dependency scanning; generated files themselves are
 * not inputs. The manifest and every fragment ARE inputs. */
export function libraryDependencyInput(member: LibraryMember, root: string): string {
  return libraryCompileInput(member, resolve(root, member.source), join(root, "build/libraries/drivers", member.id), root);
}
