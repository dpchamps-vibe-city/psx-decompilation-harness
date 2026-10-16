import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { analyzeCSource } from "./cSourceGuard.js";
import { parseC, declaratorName, field } from "./residual-source-search/tree-sitter-c.js";
import { biosFunctionProjection } from "../lib/biosFunctionMacro.js";
import { isDirectoryTu, inspectLibraryPart, libraryFunctionFilename, readLibraryTu, type LibraryTuManifest, type LibraryTuPart } from "../lib/libraryTranslationUnit.js";
import { libraryInputFiles, type LibraryProject } from "../lib/project.js";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { legacyLibrarySource, libraryMemberSource } from "../lib/librarySourceLayout.js";
import { hash } from "../lib/psyqMembers.js";

export interface LibrarySourceMove { from: string; to: string; sha256: string; action: "moved" | "deduplicated" }

/** Preflight every legacy source before moving any. Preserve complete TUs
 * verbatim, including real C and their unchanged member-ID assembly references.
 * Never choose between conflicting copies or silently relocate local headers. */
export function migrateLibrarySources(members: LibraryMember[], project: LibraryProject, root: string): LibrarySourceMove[] {
  if (project.output.sourceLayout === "tu-directory") return migrateLibraryTuDirectories(members, project, root);
  const plan: LibrarySourceMove[] = [];
  for (const member of members) {
    const from = legacyLibrarySource(project, member.id, member.member), to = member.source;
    if (from === to || !existsSync(join(root, from))) continue;
    if (!lstatSync(join(root, from)).isFile()) throw new Error(`Cannot migrate non-regular library source: ${from}`);
    const neighbors = readdirSync(dirname(join(root, from))).filter(name => name !== basename(from));
    if (neighbors.length) throw new Error(`Library source migration needs review: ${from} has neighboring files (${neighbors.join(", ")})`);
    const content = readFileSync(join(root, from)), guard = analyzeCSource(content.toString("utf8"));
    if (!guard.parses) throw new Error(`Cannot migrate invalid C: ${from}: ${guard.reasons.join("; ")}`);
    const tree = parseC(content.toString("utf8"));
    try {
      for (const include of tree.rootNode.descendantsOfType("preproc_include")) {
        const path = include.childForFieldName("path");
        if (!path || !["string_literal", "system_lib_string"].includes(path.type) ||
          (path.type === "string_literal" && path.text.slice(1, -1).split(/[\\/]/).some(piece => piece === "." || piece === "..")))
          throw new Error(`Library source migration needs include-path review: ${from}: ${include.text}`);
      }
    } finally { tree.delete(); }
    let action: LibrarySourceMove["action"] = "moved";
    if (existsSync(join(root, to))) {
      if (!lstatSync(join(root, to)).isFile() || !readFileSync(join(root, to)).equals(content))
        throw new Error(`Conflicting library sources: ${from} and ${to}; neither file was overwritten`);
      action = "deduplicated";
    }
    plan.push({ from, to, sha256: hash(content), action });
  }
  for (const move of plan) {
    const from = join(root, move.from), to = join(root, move.to);
    if (hash(readFileSync(from)) !== move.sha256) throw new Error(`Library source changed during migration: ${move.from}`);
    mkdirSync(dirname(to), { recursive: true });
    if (move.action === "moved") copyFileSync(from, to, constants.COPYFILE_EXCL);
    if (hash(readFileSync(to)) !== move.sha256 || hash(readFileSync(from)) !== move.sha256)
      throw new Error(`Library source changed during migration; both copies retained: ${move.from}`);
    unlinkSync(from);
    if (!readdirSync(dirname(from)).length) rmdirSync(dirname(from));
  }
  if (plan.length) {
    const directory = join(root, "build/libraries"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "source-migration.json"), JSON.stringify({ schemaVersion: 1, moves: plan }, null, 2) + "\n");
  }
  return plan;
}

/** Conservative AST split. Preserve definition and declaration order verbatim;
 * conditional regions and location-dependent macros require human review. */
export function planLibraryTu(member: LibraryMember, source: string): { manifest: LibraryTuManifest; files: Map<string, string> } {
  const guard = analyzeCSource(source);
  if (!guard.parses || /\b__(?:FILE|LINE|BASE_FILE|INCLUDE_LEVEL)__\b/.test(source)) throw new Error(`TU split needs source review: ${member.source}`);
  const projection = biosFunctionProjection(source), tree = parseC(projection.source), files = new Map<string, string>(), parts: LibraryTuPart[] = [];
  let cursor = 0, shared = 0;
  const support = (end: number) => {
    const text = source.slice(cursor, end);
    if (text.trim()) { const path = `_shared-${shared++}.h`; files.set(path, text); parts.push({ path }); }
    cursor = end;
  };
  try {
    for (const node of tree.rootNode.namedChildren) {
      if (node.type === "comment") continue;
      if (node.type.startsWith("preproc_") && node.type !== "preproc_include") throw new Error(`TU split needs directive review: ${node.text}`);
      if (node.type === "preproc_include") {
        const path = field(node, "path");
        if (!path || !["string_literal", "system_lib_string"].includes(path.type) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path.text.slice(1, -1)))
          throw new Error(`TU split needs include-path review: ${node.text}`);
      }
      let symbol = node.type === "function_definition" ? declaratorName(field(node, "declarator"))?.text : undefined;
      if (node.type === "expression_statement") symbol = analyzeCSource(source.slice(node.startIndex, node.endIndex)).includeAsm[0]?.symbol;
      if (!symbol) continue;
      if (symbol !== "__library_member_data" && !member.functions.some(fn => fn.name === symbol)) throw new Error(`Unexpected function in TU split: ${symbol}`);
      support(node.startIndex);
      const path = symbol === "__library_member_data" ? "_data.c" : libraryFunctionFilename(member, symbol);
      if (files.has(path)) throw new Error(`Duplicate function in TU split: ${symbol}`);
      const end = projection.sites.find(s => s.valid && s.start === node.startIndex)?.end ?? node.endIndex;
      const text = source.slice(node.startIndex, end) + "\n", part = { path, symbol };
      inspectLibraryPart(text, part); files.set(path, text); parts.push(part); cursor = end;
    }
    support(source.length);
    for (const fn of member.functions) if (!parts.some(p => p.symbol === fn.name)) throw new Error(`Missing function in TU split: ${fn.name}`);
    for (const part of parts) inspectLibraryPart(files.get(part.path)!, part);
    // Reserved filenames remain case-fold unique even on case-insensitive hosts.
    if (new Set(parts.map(p => p.path.toLowerCase())).size !== parts.length) throw new Error("TU fragment path collision");
    return { manifest: { schemaVersion: 1, member: member.id, parts }, files };
  } finally { tree.delete(); }
}
export function writeLibraryTu(member: LibraryMember, source: string, root: string): void {
  const plan = planLibraryTu(member, source), directory = dirname(join(root, member.source));
  if (existsSync(directory)) throw new Error(`TU destination already exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  for (const [path, text] of plan.files) writeFileSync(join(directory, path), text, { flag: "wx" });
  writeFileSync(join(root, member.source), JSON.stringify(plan.manifest, null, 2) + "\n", { flag: "wx" });
}
/** Newly witnessed private entries may subdivide ONLY an exclusive original
 * backlog fragment. Real C, headers, existing fragments and original bytes are
 * never rewritten to make a new inventory fit. Preflight the entire batch. */
export function extendLibraryBacklog(members: LibraryMember[], root: string): void {
  const plans: Array<{ path: string; before?: string; after: string }> = [];
  const observed = new Map<string, string>();
  for (const member of members.filter(m => isDirectoryTu(m) && existsSync(join(root, m.source)))) {
    const path = join(root, member.source), before = readFileSync(path, "utf8"); observed.set(path, before);
    const manifest = readLibraryTu(member, root, { allowDiscoveredBacklog: true });
    const present = new Set(manifest.parts.map(p => p.symbol)), missing = member.functions.filter(f => !present.has(f.name));
    if (!missing.length) continue;
    const additions = new Map<string, LibraryTuPart[]>();
    for (const fn of missing) {
      const owners = member.functions.filter(f => f.section === fn.section && present.has(f.name)).sort((a, b) => a.offset - b.offset);
      const owner = owners.findLast(f => f.offset < fn.offset) ?? owners[0];
      if (!owner || !fn.discovery) throw new Error(`Private split needs source review: ${member.id}::${fn.name}`);
      const part = manifest.parts.find(p => p.symbol === owner.name)!, source = join(dirname(path), part.path), text = readFileSync(source, "utf8");
      observed.set(source, text);
      const guard = analyzeCSource(text);
      if (!inspectLibraryPart(text, part).stub || guard.includeAsm[0]!.folder !== `build/libraries/nonmatchings/${member.id}`)
        throw new Error(`Private split needs source review: ${source} contains real C or noncanonical assembly; no edits made`);
      const next = { path: libraryFunctionFilename(member, fn.name), symbol: fn.name };
      const target = join(dirname(path), next.path), after = `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", ${fn.name});\n`;
      inspectLibraryPart(after, next);
      if (manifest.parts.some(p => p.path.toLowerCase() === next.path.toLowerCase()) || existsSync(target))
        throw new Error(`Private split destination already exists: ${target}; no edits made`);
      plans.push({ path: target, after });
      const group = additions.get(owner.name) ?? []; group.push(next); additions.set(owner.name, group);
    }
    const parts = manifest.parts.flatMap(part => {
      const group = part.symbol ? additions.get(part.symbol) ?? [] : [];
      const owner = member.functions.find(f => f.name === part.symbol);
      const earlier = group.filter(p => member.functions.find(f => f.name === p.symbol)!.offset < owner!.offset);
      return [...earlier, part, ...group.filter(p => !earlier.includes(p))];
    });
    plans.push({ path, before, after: JSON.stringify({ ...manifest, parts }, null, 2) + "\n" });
  }
  for (const [path, before] of observed) if (readFileSync(path, "utf8") !== before) throw new Error(`Source changed during private split: ${path}`);
  for (const plan of plans) {
    if (plan.before === undefined) writeFileSync(plan.path, plan.after, { flag: "wx" });
    else writeFileSync(plan.path, plan.after);
  }
  if (plans.length) {
    mkdirSync(join(root, "build/libraries"), { recursive: true });
    writeFileSync(join(root, "build/libraries/private-split-migration.json"), JSON.stringify({ schemaVersion: 1,
      changes: plans.map(p => ({ path: p.path, ...(p.before ? { beforeHash: hash(p.before) } : {}), afterHash: hash(p.after) })) }, null, 2) + "\n");
  }
}
function migrateLibraryTuDirectories(members: LibraryMember[], project: LibraryProject, root: string): LibrarySourceMove[] {
  const plans: Array<{ member: LibraryMember; from: string; content: string; plan: ReturnType<typeof planLibraryTu> }> = [];
  const inputs = new Map(libraryInputFiles(project, root).map(input => [input.path, input]));
  for (const member of members) {
    if (!isDirectoryTu(member)) throw new Error(`Not a directory TU: ${member.source}`);
    const grouped = libraryMemberSource({ ...project, output: { ...project.output, sourceLayout: "grouped" } },
      inputs.get(member.input)!,
      { name: member.member, ordinal: member.ordinal }, member.id);
    const candidates = [...new Set([grouped, legacyLibrarySource(project, member.id, member.member)])].filter(p => existsSync(join(root, p)));
    if (existsSync(join(root, member.source))) {
      if (candidates.length) throw new Error(`Conflicting monolithic and directory TU: ${member.source}; no edits made`);
      readLibraryTu(member, root, { allowDiscoveredBacklog: true }); continue;
    }
    if (!candidates.length) continue;
    const from = candidates[0]!;
    if (candidates.length !== 1 || !lstatSync(join(root, from)).isFile()) throw new Error(`TU migration needs source review: ${from}`);
    const content = readFileSync(join(root, from), "utf8");
    const tree = parseC(content);
    try { for (const node of tree.rootNode.descendantsOfType("preproc_include")) {
      const path = field(node, "path");
      if (path?.type === "string_literal" && existsSync(join(dirname(join(root, from)), path.text.slice(1, -1))))
        throw new Error(`TU migration needs local-header review: ${from}: ${node.text}`);
    } } finally { tree.delete(); }
    if (existsSync(dirname(join(root, member.source)))) throw new Error(`TU destination already exists: ${member.source}`);
    plans.push({ member, from, content, plan: planLibraryTu(member, content) });
  }
  // Preflight the entire batch, then publish directories before removing old
  // copies. The report keeps the source hash and exact ordered fragments.
  for (const p of plans) if (readFileSync(join(root, p.from), "utf8") !== p.content) throw new Error(`Source changed during TU migration: ${p.from}`);
  extendLibraryBacklog(members, root);
  const moves = plans.map(p => ({ from: p.from, to: p.member.source, sha256: hash(p.content), action: "moved" as const }));
  for (const p of plans) {
    writeLibraryTu(p.member, p.content, root);
    if (readFileSync(join(root, p.from), "utf8") !== p.content) throw new Error(`Source changed; both TU copies retained: ${p.from}`);
    unlinkSync(join(root, p.from));
    if (!readdirSync(dirname(join(root, p.from))).length) rmdirSync(dirname(join(root, p.from)));
  }
  if (moves.length) { mkdirSync(join(root, "build/libraries"), { recursive: true });
    writeFileSync(join(root, "build/libraries/source-migration.json"), JSON.stringify({ schemaVersion: 2, moves }, null, 2) + "\n"); }
  return moves;
}
