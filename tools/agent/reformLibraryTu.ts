/** Re-form an assembly TU whose original object GCC compiled (LNK symbol IDs
 * from 3) into the C TU split would have written. Only unedited extraction is
 * eligible: a retained, hash-bound handwritten extraction or a bare backlog
 * wrapper. Hand-written functions inside the member become retained parts. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { loadLibraryProject } from "../lib/project.js";
import { libraryMembers, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { libraryAssemblyParts, librarySourceScaffold, writeLibraryAssemblyParts } from "../lib/libraryAssembly.js";
import { libraryAssemblyTu, librarySourceFiles, libraryTuStatus, readLibraryTu } from "../lib/libraryTranslationUnit.js";
import { writeLibraryTu } from "./librarySources.js";
import { applyRetainedFlags, checkLibrary, disassembleLibraryMember, ensureSymbolsPart, tuFormOriginMismatches } from "./libraryTarget.js";

export interface ReformReport {
  written: boolean;
  members: Array<{ id: string; removed: string[]; parts: string[]; retained: string[] }>;
}

export function reformLibraryTus(write = false, ids: string[] = [], root = projectRoot(),
  verify: (member: LibraryMember) => void = member => checkLibrary(["--member", member.id], root)): ReformReport {
  const all = libraryMembers(root);
  return withLibraryMetadata(() => {
    const candidates = tuFormOriginMismatches(all, root);
    const selected = ids.length ? ids.map(id => candidates.find(m => m.id === id) ?? fail(`${id}: not an assembly TU of a GCC-compiled member`)) : candidates;
    const report: ReformReport = { written: write, members: [] };
    for (const member of selected) {
      if (!libraryAssemblyTu(member, root)!.part.backlog) fail(`${member.id}: its assembly part is authored source, not extraction; convert it by hand`);
      libraryTuStatus(member, root); // Retained extraction must still match its recorded hashes.
      report.members.push({ id: member.id, removed: librarySourceFiles(member, root), parts: [], retained: [] });
    }
    if (!write) return report;
    const project = loadLibraryProject(root)!;
    for (const [i, member] of selected.entries()) {
      const directory = join(root, dirname(member.source));
      const snapshot = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
      try {
        for (const file of report.members[i]!.removed) rmSync(join(root, file));
        const leftovers = readdirSync(directory);
        if (leftovers.length) throw new Error(`files outside the TU need review first: ${leftovers.join(", ")}`);
        rmSync(directory, { recursive: true });
        const parts = libraryAssemblyParts(member, readFileSync(disassembleLibraryMember(member, root), "utf8"));
        writeLibraryAssemblyParts(member, parts, root);
        writeLibraryTu(member, librarySourceScaffold(member, project.headers.context, parts), root);
        ensureSymbolsPart(member, parts, root);
        applyRetainedFlags([member], root);
        verify(member);
        const manifest = readLibraryTu(member, root);
        report.members[i]!.parts = manifest.parts.map(p => p.path);
        report.members[i]!.retained = manifest.parts.filter(p => p.retained).map(p => p.symbol!);
      } catch (error) {
        if (existsSync(directory)) for (const name of readdirSync(directory)) if (!snapshot.has(name)) rmSync(join(directory, name), { recursive: true });
        mkdirSync(directory, { recursive: true });
        for (const [name, bytes] of snapshot) writeFileSync(join(directory, name), bytes);
        throw new Error(`${member.id}: reform failed and was rolled back (${relative(root, directory)} restored): ${error instanceof Error ? error.message : error}`);
      }
    }
    return report;
  }, all, root);
}
function fail(message: string): never { throw new Error(message); }
