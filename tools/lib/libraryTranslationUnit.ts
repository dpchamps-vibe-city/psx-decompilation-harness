/** Ordered source fragments are ONE production compiler TU, never isolated
 * objects joined after matching. The manifest contains no compiler flags. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { LibraryMember } from "./libraryTargets.js";
import { analyzeCSource } from "../agent/cSourceAnalysis.js";
import { extractSignaturesFromSource } from "../agent/sdkTypes.js";
import { parseC } from "../agent/residual-source-search/tree-sitter-c.js";

export interface LibraryTuPart { path: string; symbol?: string }
export interface LibraryTuManifest { schemaVersion: 1; member: string; parts: LibraryTuPart[] }
export const isDirectoryTu = (member: LibraryMember) => member.source.endsWith("/tu.json");
export function libraryFunctionFilename(member: LibraryMember, symbol: string): string {
  const original = member.functions.filter(fn => !fn.discovery);
  if (member.object) original.sort((a, b) => member.object.symbols.findIndex(s => s.name === a.name) - member.object.symbols.findIndex(s => s.name === b.name));
  const fn = member.functions.find(fn => fn.name === symbol);
  // Newly recovered entries must not renumber existing case-distinct source
  // files. Original symbol-TABLE ordinals (not address order) retain the
  // established path contract even when the function inventory is sorted.
  if (fn?.discovery) {
    const collision = member.functions.filter(f => f.name.toLowerCase() === symbol.toLowerCase()).length > 1;
    const prefix = collision ? `private-${member.object.sections.get(fn.section)!.index}-${fn.offset.toString(16)}-` : "";
    return `${prefix}${symbol}.c`;
  }
  const collision = original.filter(fn => fn.name.toLowerCase() === symbol.toLowerCase()).length > 1;
  return `${collision ? `${original.findIndex(fn => fn.name === symbol)}-` : ""}${symbol}.c`;
}
export function libraryFunctionSource(member: LibraryMember, symbol: string): string {
  return isDirectoryTu(member) ? join(dirname(member.source), libraryFunctionFilename(member, symbol)).replaceAll("\\", "/") : member.source;
}
export function readLibraryTu(member: LibraryMember, root: string, options: { allowDiscoveredBacklog?: boolean } = {}): LibraryTuManifest {
  const manifest = JSON.parse(readFileSync(resolve(root, member.source), "utf8")) as LibraryTuManifest;
  if (manifest.schemaVersion !== 1 || manifest.member !== member.id || !Array.isArray(manifest.parts) || !manifest.parts.length ||
      Object.keys(manifest).some(k => !["schemaVersion", "member", "parts"].includes(k))) throw new Error(`Invalid TU manifest: ${member.source}`);
  const paths = new Set<string>(), symbols = new Set<string>();
  for (const part of manifest.parts) {
    if (!part || Object.keys(part).some(k => !["path", "symbol"].includes(k)) || typeof part.path !== "string" ||
        !/^[A-Za-z_0-9][A-Za-z_0-9.-]*\.[ch]$/.test(part.path) || paths.has(part.path.toLowerCase())) throw new Error(`Invalid/duplicate TU part: ${member.source}`);
    paths.add(part.path.toLowerCase());
    const directory = realpathSync(resolve(root, dirname(member.source)));
    if (dirname(realpathSync(resolve(directory, part.path))) !== directory) throw new Error(`TU part escapes its directory: ${part.path}`);
    if (part.symbol !== undefined) {
      if (!/^[A-Za-z_]\w*$/.test(part.symbol) || symbols.has(part.symbol)) throw new Error(`Invalid/duplicate TU symbol: ${part.symbol}`);
      symbols.add(part.symbol);
      if (part.symbol !== "__library_member_data" && part.path !== libraryFunctionFilename(member, part.symbol)) throw new Error(`Function TU part must be ${libraryFunctionFilename(member, part.symbol)}`);
    }
  }
  if (member.functions.some(fn => !symbols.has(fn.name) && !(options.allowDiscoveredBacklog && fn.discovery !== undefined)) || [...symbols].some(s => s !== "__library_member_data" && !member.functions.some(fn => fn.name === s)))
    throw new Error(`TU manifest must list every original function exactly once: ${member.source}`);
  return manifest;
}
export function librarySourceFiles(member: LibraryMember, root: string): string[] {
  return isDirectoryTu(member) ? [member.source, ...readLibraryTu(member, root).parts.map(p => join(dirname(member.source), p.path))] : [member.source];
}
/** Strict file boundary: a function file is either its sole canonical stub or
 * one definition; shared files cannot hide functions or assembly placeholders. */
export function inspectLibraryPart(text: string, part: LibraryTuPart): { stub: boolean } {
  const guard = analyzeCSource(text);
  if (!guard.parses) throw new Error(`${part.path}: invalid C: ${guard.reasons.join("; ")}`);
  const signatures = extractSignaturesFromSource(text);
  if (guard.includeAsm.length) {
    const tree = parseC(text);
    try {
      const code = tree.rootNode.namedChildren.filter(n => !["comment", "preproc_include"].includes(n.type));
      if (!part.symbol || guard.includeAsm.length !== 1 || guard.includeAsm[0]!.symbol !== part.symbol || code.length !== 1 ||
          code[0]!.type !== "expression_statement" || signatures.length) throw new Error(`${part.path}: mixed/partial stub source is forbidden`);
    } finally { tree.delete(); }
    return { stub: true };
  }
  if (part.symbol && part.symbol !== "__library_member_data") {
    if (signatures.length !== 1 || signatures[0]!.name !== part.symbol) throw new Error(`${part.path}: must define only ${part.symbol}`);
    const tree = parseC(text);
    try {
      if (tree.rootNode.descendantsOfType("function_definition").length > 1)
        throw new Error(`${part.path}: nested function definitions are not C89 function fragments`);
    } finally { tree.delete(); }
  } else if (signatures.length) throw new Error(`${part.path}: shared/data part cannot define functions`);
  return { stub: false };
}
export function libraryTuStatus(member: LibraryMember, root: string, replacement?: { symbol: string; source: string }) {
  if (!isDirectoryTu(member)) return undefined;
  return readLibraryTu(member, root).parts.map(part => {
    const path = replacement && replacement.symbol === part.symbol ? replacement.source : resolve(root, dirname(member.source), part.path);
    const text = readFileSync(path, "utf8"), status = inspectLibraryPart(text, part);
    if (status.stub && analyzeCSource(text).includeAsm[0]!.folder !== `build/libraries/nonmatchings/${member.id}`) throw new Error(`${part.path}: backlog must reference this member's original assembly`);
    return { ...part, source: path, ...status };
  });
}
/** Used by production, every diagnostic compiler and the async preparer. The
 * same ordered include driver substitutes at most ONE function fragment. */
export function libraryCompileInput(member: LibraryMember, source: string, outputDir: string, root: string, symbol?: string): string {
  if (!isDirectoryTu(member)) return source;
  const absolute = resolve(root, source), owner = resolve(root, member.source);
  const definitions = absolute === owner ? [] : extractSignaturesFromSource(readFileSync(absolute, "utf8")).filter(s => member.functions.some(fn => fn.name === s.name));
  const selected = symbol ?? member.functions.find(fn => resolve(root, libraryFunctionSource(member, fn.name)) === absolute)?.name ?? (definitions.length === 1 ? definitions[0]!.name : undefined);
  if (absolute !== owner && !selected) throw new Error(`A TU candidate must identify one function: ${source}`);
  const status = libraryTuStatus(member, root, absolute === owner ? undefined : { symbol: selected!, source: absolute })!;
  mkdirSync(outputDir, { recursive: true });
  const driver = join(outputDir, "translation-unit.c");
  writeFileSync(driver, `/* Generated production TU: ${member.id}. Do not edit. */\n` + status.map(p => `#include ${JSON.stringify(p.source)}\n`).join(""));
  return driver;
}
/** Deterministic driver for dependency scanning; generated files themselves are
 * not inputs. The manifest and every fragment ARE inputs. */
export function libraryDependencyInput(member: LibraryMember, root: string): string {
  return libraryCompileInput(member, resolve(root, member.source), join(root, "build/libraries/drivers", member.id), root);
}
