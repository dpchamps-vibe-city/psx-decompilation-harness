/** Real-member onboarding check: SDK preprocessing -> split contract ->
 * production TU compilation -> strict whole-member oracle -> selected m2c
 * preparation. Assembly-backlog identity is setup evidence, NOT C completion.
 * Draft compilation remains an explicit separate result: unresolved C types
 * must not be relabelled a disassembler/configuration failure. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { requireLibraryFunction, libraryMembers, withLibraryMetadata } from "../lib/libraryTargets.js";
import { libraryAssemblyParts, librarySourceScaffold } from "../lib/libraryAssembly.js";
import { librarySourceFiles, libraryAssemblyTu, libraryTuStatus, isDirectoryTu } from "../lib/libraryTranslationUnit.js";
import { compareRelocatableObjects, type ObjectComparison } from "../lib/relocatableObject.js";
import { snapshot } from "../lib/contentCache.js";
import { loadLibraryProject } from "../lib/project.js";
import { sdkPrototypes } from "./calleeTruth.js";
import { compileSource, rejectionFromDiagnostics } from "./decompToolchain.js";
import { prepareLibraryFunction } from "./libraryTarget.js";

export interface LibraryPreflightReport {
  status: "passed" | "failed";
  target: string;
  scope: "configuration/split/preparation; not decompilation completion";
  stages: Array<{ name: string; status: "passed" | "failed"; detail: string }>;
  memberComparison?: ObjectComparison;
  preparation?: { path: string; generation: string; compilation: string; comparison: string; blockers: string[] };
  report: string;
}
export interface LibrarySplitCheckReport {
  status: "passed" | "failed";
  scope: "generated original assembly splits only; not live C or decompilation completion";
  members: Array<{ id: string; verdict: string; differences: string[] }>;
  report: string;
}
/** Check every published reference split under the actual compiler/assembler
 * profiles. This explicitly substitutes ALL original backlog fragments in a
 * generated diagnostic scaffold, never live C, and publishes no acceptance
 * records. A clean split cannot certify an existing nonmatching C attempt. */
export function checkLibrarySplits(): LibrarySplitCheckReport {
  const root = projectRoot(), project = loadLibraryProject(root)!, members = libraryMembers(root);
  const directory = join(root, "build/libraryPreflight/splits", `${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const report: LibrarySplitCheckReport = { status: "failed",
    scope: "generated original assembly splits only; not live C or decompilation completion", members: [],
    report: relative(root, join(directory, "report.json")) };
  const parts = members.map(member => ({ member, parts: libraryAssemblyParts(member, readFileSync(join(root, member.assembly), "utf8")) }));
  const paths = ["toolchain.json", "project.json", ...project.headers.reference, ...project.headers.owned,
    ...members.map(m => m.input), ...parts.flatMap(({ member, parts }) => parts.map(p => `build/libraries/nonmatchings/${member.id}/${p.symbol}.s`))];
  const before = snapshot(root, paths);
  withLibraryMetadata(() => {
    for (const { member, parts: fragments } of parts) {
      const output = join(directory, member.id); mkdirSync(output);
      const source = join(output, "original-scaffold.c");
      writeFileSync(source, librarySourceScaffold(member, project.headers.context, fragments));
      try {
        const artifacts = compileSource(source, join(output, "compile"), member.id, { assemble: true, containerKind: "library", containerId: member.id });
        const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
        if (rejection) throw new Error(`Invalid scaffold: ${rejection}`);
        const comparison = compareRelocatableObjects(member.bytes, readFileSync(artifacts.object!));
        report.members.push({ id: member.id, verdict: comparison.verdict, differences: comparison.differences });
      } catch (error) { report.members.push({ id: member.id, verdict: "failed", differences: [String(error)] }); }
    }
  }, members, root);
  if (JSON.stringify(snapshot(root, paths)) !== JSON.stringify(before))
    report.members.push({ id: "input-stability", verdict: "failed", differences: ["Inputs changed during split verification"] });
  if (report.members.length && report.members.every(m => m.verdict === "match")) report.status = "passed";
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export async function preflightLibraryFunction(name: string): Promise<LibraryPreflightReport> {
  const root = projectRoot(), { member, key } = requireLibraryFunction(name), project = loadLibraryProject(root)!;
  const directory = join(root, "build/libraryPreflight", key, `${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const report: LibraryPreflightReport = { status: "failed", target: key,
    scope: "configuration/split/preparation; not decompilation completion", stages: [], report: relative(root, join(directory, "report.json")) };
  let stage = "input snapshot";
  try {
    const paths = ["toolchain.json", "project.json", member.input, ...project.headers.reference, ...librarySourceFiles(member, root)];
    const before = snapshot(root, paths);
    stage = "SDK header preprocessing";
    const headers = sdkPrototypes(key);
    report.stages.push({ name: stage, status: "passed", detail: `${headers.size} witnessed SDK prototypes; every configured reference header preprocessed` });
    stage = "ordered split contract";
    const parts = isDirectoryTu(member) ? libraryTuStatus(member, root)! : [];
    report.stages.push({ name: stage, status: "passed", detail: `${member.functions.length} original/inferred entries; ${parts.filter(p => p.stub).length} explicit backlog parts` });
    stage = "production TU and whole-member oracle";
    const artifacts = compileSource(member.source, join(directory, "compile"), member.id, { assemble: true, containerKind: "library", containerId: member.id });
    const rejection = rejectionFromDiagnostics(artifacts.diagnostics);
    if (rejection) throw new Error(`Invalid C: ${rejection}`);
    report.memberComparison = compareRelocatableObjects(member.bytes, readFileSync(artifacts.object!));
    if (report.memberComparison.verdict !== "match") throw new Error(report.memberComparison.differences.join("; "));
    report.stages.push({ name: stage, status: "passed", detail: "All original code/data bytes, symbols and relocations retained; backlog is not reconstructed C" });
    stage = "selected-function preparation";
    const assemblyTu = libraryAssemblyTu(member, root);
    if (assemblyTu) report.stages.push({ name: stage, status: "passed", detail: `assembly translation unit (${assemblyTu.part.path}); no C draft is prepared` });
    else {
    // Exercise today's listing/context/toolchain, not a cached earlier draft.
    // Alternatives preserve existing source/drafts and never promote them.
    const prepared = await prepareLibraryFunction(key, { alternative: true }), packet = prepared.packet;
    report.preparation = { path: prepared.path, generation: packet.generation.status, compilation: packet.compilation.status,
      comparison: packet.comparison.status, blockers: packet.integration.blockers };
    if (!packet.primary || packet.generation.status === "failed") throw new Error(packet.integration.blockers.join("; ") || "No selected C draft");
    report.stages.push({ name: stage, status: "passed", detail: `C draft available; candidate compilation ${packet.compilation.status}, comparison ${packet.comparison.status} (separate claims)` });
    }
    stage = "input stability";
    if (JSON.stringify(snapshot(root, paths)) !== JSON.stringify(before)) throw new Error("Project source/configuration/reference inputs changed during preflight");
    report.stages.push({ name: stage, status: "passed", detail: "No live inputs changed" });
    report.status = "passed";
  } catch (error) {
    report.stages.push({ name: stage, status: "failed", detail: String(error) });
  }
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
