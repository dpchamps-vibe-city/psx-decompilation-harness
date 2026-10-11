import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { analyzeCSource } from "./cSourceGuard.js";
import { parseC } from "./residual-source-search/tree-sitter-c.js";
import type { LibraryProject } from "../lib/project.js";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { legacyLibrarySource } from "../lib/librarySourceLayout.js";
import { hash } from "../lib/psyqMembers.js";

export interface LibrarySourceMove { from: string; to: string; sha256: string; action: "moved" | "deduplicated" }

/** Preflight every legacy source before moving any. Preserve complete TUs
 * verbatim, including real C and their unchanged member-ID assembly references.
 * Never choose between conflicting copies or silently relocate local headers. */
export function migrateLibrarySources(members: LibraryMember[], project: LibraryProject, root: string): LibrarySourceMove[] {
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
