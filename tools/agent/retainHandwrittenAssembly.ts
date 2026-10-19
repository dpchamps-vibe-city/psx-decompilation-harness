/** Retain existing preprocessor-input extraction verbatim. This never
 * translates assembly, changes classification, or replaces C implementations. */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { libraryMembers, libraryObjectInputs, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { libraryAssemblyInputs } from "../lib/libraryAssembly.js";
import { libraryAssemblyTu, libraryTuStatus, readLibraryTu, type LibraryTuManifest, type RetainedHandwrittenAssembly } from "../lib/libraryTranslationUnit.js";
import { fileDigest } from "../lib/contentCache.js";

export interface RetainedAssemblyReport {
  written: boolean;
  scope: "unchanged original-derived assembly; not recovered author source";
  members: Array<{ id: string; functions: string[]; source: string; files: string[]; alreadyRetained: boolean }>;
}
/** Validate every selected member before publishing any file. Only explicitly
 * assembly-classified backlog TUs are eligible; real C/assembly is untouched. */
export function retainHandwrittenAssembly(write = false, root = projectRoot(), members = libraryMembers(root)): RetainedAssemblyReport {
  return withLibraryMetadata(() => {
    const plans: Array<{ member: LibraryMember; manifest: LibraryTuManifest; copies: Array<{ from: string; to: string }>; old: string; oldText: string }> = [];
    const report: RetainedAssemblyReport = { written: write, scope: "unchanged original-derived assembly; not recovered author source", members: [] };
    for (const member of members) {
      const tu = libraryAssemblyTu(member, root);
      if (!tu || !tu.part.backlog) continue;
      libraryTuStatus(member, root);
      if (tu.part.handwritten) {
        report.members.push({ id: member.id, functions: tu.symbols, source: relative(root, tu.source),
          files: [tu.part.handwritten.declarations.path, tu.part.handwritten.assembly.path], alreadyRetained: true });
        continue;
      }
      if (!member.originalObject) throw new Error(`${member.id}: retaining handwritten extraction requires a native original`);
      libraryObjectInputs(member, root);
      const directory = dirname(tu.source), manifest = readLibraryTu(member, root);
      const files = [
        { symbol: "__library_member_symbols", path: "handwritten-symbols.ASM" },
        { symbol: "__library_member_assembly", path: "handwritten.ASM" },
      ];
      const copies = files.map(f => {
        libraryAssemblyInputs(member, f.symbol, root); // Fresh CPP receipt binds the untouched .ASM input too.
        const from = join(root, "build/libraries/nonmatchings", member.id, `${f.symbol}.ASM`), to = join(directory, f.path);
        if (existsSync(to) && fileDigest(to) !== fileDigest(from)) throw new Error(`${member.id}: refusing to overwrite ${f.path}`);
        return { from, to };
      });
      const metadata: RetainedHandwrittenAssembly = { kind: "original-extraction", format: "assembler-with-cpp", originalSha256: member.originalObject.sha256,
        declarations: { path: files[0]!.path, sha256: fileDigest(copies[0]!.from) },
        assembly: { path: files[1]!.path, sha256: fileDigest(copies[1]!.from) } };
      manifest.parts = [{ path: files[1]!.path, symbols: tu.symbols, backlog: true, handwritten: metadata }];
      plans.push({ member, manifest, copies, old: tu.source, oldText: readFileSync(tu.source, "utf8") });
      report.members.push({ id: member.id, functions: tu.symbols, source: relative(root, copies[1]!.to), files: files.map(f => f.path), alreadyRetained: false });
    }
    if (write) for (const plan of plans) {
      for (const c of plan.copies) copyFileSync(c.from, c.to); // Byte-for-byte source copy, never a spelling/encoding pass.
      writeFileSync(join(root, plan.member.source), JSON.stringify(plan.manifest, null, 2) + "\n");
      libraryTuStatus(plan.member, root);
      // Remove only a bare former wrapper. Disabled attempts stay verbatim in
      // their original file, uncompiled; never discard them as migration debris.
      const bare = ["__library_member_symbols", "__library_member_assembly"].map(s => `.include "build/libraries/nonmatchings/${plan.member.id}/${s}.s"\n`).join("");
      if (plan.oldText === bare && !plan.copies.some(c => c.to === plan.old)) unlinkSync(plan.old);
    }
    return report;
  }, members, root);
}
