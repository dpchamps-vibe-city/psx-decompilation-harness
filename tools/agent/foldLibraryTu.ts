/** Fold a finished C TU's ordered parts into ONE module per original object:
 * the exact inverse of the per-function split (`planLibraryTu`). Parts are
 * joined verbatim in manifest order; only empty generated parts drop out.
 * Retained hand-written functions stay their canonical INCLUDE_ASM lines. The
 * folded module must rebuild the original object hash, or nothing changes. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { compareLibraryObjects, libraryMembers, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { libraryAssemblyInputs } from "../lib/libraryAssembly.js";
import { activeSourceText } from "../lib/disabledSource.js";
import { inspectLibraryPart, isDirectoryTu, isLibraryGeneratedSymbol, libraryAssemblyTu, libraryModulePart, libraryTuStatus, readLibraryTu,
  type LibraryTuManifest, type RetainedHandwrittenFunction } from "../lib/libraryTranslationUnit.js";
import { compileSource } from "./decompToolchain.js";
import { analyzeCSource, matchingConstructs } from "./cSourceAnalysis.js";
import { checkLibrary } from "./libraryTarget.js";

export interface FoldRow { id: string; module: string; parts: string[]; verdict?: string; refused?: string; written?: boolean; beforeSha256?: string; afterSha256?: string }
export interface FoldReport { written: boolean; members: FoldRow[] }
/** Prefix of the one-line machine report `fold --json` prints last. */
export const FOLD_STATUS = "PSX_FOLD_REPORT ";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The module's name: the original object's stem, lowercased (`QSORT.OBJ` → `qsort.c`). */
export function libraryModuleFilename(member: LibraryMember): string {
  const stem = member.member.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  return /^[a-z0-9_]/.test(stem) ? `${stem}.c` : "module.c";
}

/** Folded modules whose current text has not passed the agent cleanup. */
export function pendingFoldCleanups(root = projectRoot(), members = libraryMembers(root)): LibraryMember[] {
  return members.filter(member => {
    const module = libraryModulePart(member, root);
    return module && module.cleanedSha256 !== sha256(readFileSync(join(root, dirname(member.source), module.path), "utf8"));
  });
}
/** Mark the module's current text as cleaned; the gate that follows verifies it. */
export function recordFoldCleanup(member: LibraryMember, root = projectRoot()): string {
  const manifest = readLibraryTu(member, root), part = manifest.parts[0]!;
  if (manifest.parts.length !== 1 || !part.symbols || !part.path.endsWith(".c")) throw new Error(`${member.id} is not a folded module`);
  part.cleanedSha256 = sha256(readFileSync(join(root, dirname(member.source), part.path), "utf8"));
  writeFileSync(join(root, member.source), JSON.stringify(manifest, null, 2) + "\n");
  return part.cleanedSha256;
}

/** Why a member cannot fold yet, or undefined when it can. */
export function foldRefusal(member: LibraryMember, root: string): string | undefined {
  if (!isDirectoryTu(member) || !existsSync(join(root, member.source))) return "not a split C TU";
  if (libraryAssemblyTu(member, root)) return "assembly TU; nothing to fold";
  if (libraryModulePart(member, root)) return "already folded";
  const status = libraryTuStatus(member, root)!;
  const open = status.find(p => p.stub && !p.retained);
  if (open) return `${open.path} is still extraction`;
  for (const part of new Set(status.map(p => p.source))) {
    const text = readFileSync(part, "utf8");
    if (/PARKED by \/auto_decompilation_loop|PSX parked attempt/.test(text)) return `${relative(root, part)} holds a preserved attempt; settle it first`;
    if (/\b__(?:FILE|LINE|BASE_FILE|INCLUDE_LEVEL)__\b/.test(text)) return `${relative(root, part)} uses a location-dependent macro`;
  }
  /* One faithful module: each object has one name and one type. An asm label
     is the split era's second C name for a label — in a part or in a private
     header beside it. `library -- unalias` retires what it can; the rest is
     restructured before the fold. */
  const directory = join(root, dirname(member.source));
  for (const name of readdirSync(directory).filter(name => /\.(?:c|h)$/.test(name)).sort()) {
    const text = readFileSync(join(directory, name), "utf8");
    const label = analyzeCSource(text).parses ? matchingConstructs(text).asmLabels[0] : undefined;
    if (label) return `${relative(root, join(directory, name))}:${label.line} declares ${label.name} through asm label "${label.label}"; declare it by its listing name first`;
  }
  return undefined;
}

/** The module text and manifest: every part verbatim, in order. */
export function composeLibraryModule(member: LibraryMember, root: string): { path: string; text: string; manifest: LibraryTuManifest } {
  const manifest = readLibraryTu(member, root), directory = join(root, dirname(member.source));
  const symbols: string[] = [], retainedFunctions: Record<string, RetainedHandwrittenFunction> = {};
  let text = "";
  for (const part of manifest.parts) {
    const source = readFileSync(join(directory, part.path), "utf8");
    // A generated part reduced to comments contributes nothing to the TU.
    if (isLibraryGeneratedSymbol(part.symbol) && !activeSourceText(source).replace(/\/\*[\s\S]*?\*\//g, "").trim()) continue;
    if (part.symbol && !isLibraryGeneratedSymbol(part.symbol)) symbols.push(part.symbol);
    if (part.retained) retainedFunctions[part.symbol!] = part.retained;
    text += source.endsWith("\n") ? source : `${source}\n`;
  }
  const path = libraryModuleFilename(member);
  const part = { path, symbols, ...(Object.keys(retainedFunctions).length ? { retainedFunctions } : {}) };
  inspectLibraryPart(text, part);
  return { path, text, manifest: { schemaVersion: 1, member: member.id, parts: [part] } };
}

/** Check (default) or write folds. A check builds the module from a staged
 * driver under build/ and requires the original object hash; --write then
 * replaces the parts transactionally and re-verifies the member. */
export function foldLibraryTus(write = false, ids: string[] = [], root = projectRoot(),
  verify: (member: LibraryMember) => void = member => checkLibrary(["--member", member.id], root)): FoldReport {
  const all = libraryMembers(root);
  return withLibraryMetadata(() => {
    const selected = ids.length ? ids.map(id => all.find(m => m.id === id) ?? fail(`Unknown library member ${id}`)) : all.filter(m => !foldRefusal(m, root));
    const report: FoldReport = { written: write, members: [] };
    for (const member of selected) {
      const refusal = foldRefusal(member, root), row: FoldRow = { id: member.id, module: libraryModuleFilename(member), parts: [] };
      report.members.push(row);
      if (refusal) { row.refused = refusal; continue; }
      const module = composeLibraryModule(member, root);
      row.parts = readLibraryTu(member, root).parts.map(p => p.path);
      const stage = join(root, "build/libraries/fold", member.id);
      rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, module.path), module.text);
      for (const symbol of Object.keys(module.manifest.parts[0]!.retainedFunctions ?? {})) libraryAssemblyInputs(member, symbol, root);
      // Same driver shape as production: the module is the TU's only include.
      writeFileSync(join(stage, "translation-unit.c"), `/* Generated fold check: ${member.id}. */\n#include ${JSON.stringify(join(stage, module.path))}\n`);
      const artifacts = compileSource(join(stage, "translation-unit.c"), join(stage, "build"), member.id, { assemble: true, containerKind: "library", containerId: member.id });
      row.verdict = compareLibraryObjects(member, readFileSync(artifacts.object!)).verdict;
      if (row.verdict !== "match" || !write) continue;
      const directory = join(root, dirname(member.source));
      const snapshot = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
      row.beforeSha256 = sha256(row.parts.map(p => snapshot.get(p)!.toString("utf8")).join(""));
      try {
        for (const part of row.parts) if (part !== module.path) rmSync(join(directory, part));
        writeFileSync(join(directory, module.path), module.text);
        writeFileSync(join(root, member.source), JSON.stringify(module.manifest, null, 2) + "\n");
        libraryTuStatus(member, root);
        verify(member);
        row.written = true; row.afterSha256 = sha256(module.text);
      } catch (error) {
        for (const name of readdirSync(directory)) if (!snapshot.has(name)) rmSync(join(directory, name));
        for (const [name, bytes] of snapshot) writeFileSync(join(directory, name), bytes);
        throw new Error(`${member.id}: fold failed and was rolled back: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (write && report.members.some(m => m.written)) {
      const path = join(root, "build/libraries/fold-migration.json");
      const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as FoldRow[] : [];
      writeFileSync(path, JSON.stringify([...prior, ...report.members.filter(m => m.written)], null, 2) + "\n");
    }
    return report;
  }, all, root);
}
function fail(message: string): never { throw new Error(message); }
