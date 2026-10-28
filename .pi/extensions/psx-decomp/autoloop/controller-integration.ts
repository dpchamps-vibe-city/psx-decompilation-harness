import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "../../shared/workspace.js";
import { runCommand } from "../../shared/process.js";
import { analyzeCSource } from "../../../../tools/agent/cSourceAnalysis.js";
import { libraryMemberForSource } from "../../../../tools/lib/libraryTargets.js";
import { loadLibraryProject } from "../../../../tools/lib/project.js";
import { inspectLibraryPart, isDirectoryTu, readLibraryTu } from "../../../../tools/lib/libraryTranslationUnit.js";

export interface SourceSnapshot { path: string; text: string | null; boundary?: string }
export interface WorkerDraft {
  source: SourceSnapshot;
  candidate: string;
  headerPatch: string;
  headerApplied?: boolean;
}
export interface WorkerPromotion {
  applied: boolean;
  feedback: string;
  /** Restore only our unchanged writes, never another writer's edits. */
  rollback?: () => Promise<void>;
}
const textAt = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
function contract(root: string, path: string) {
  if (!loadLibraryProject(root)) return undefined;
  const member = libraryMemberForSource(path, root);
  if (!member) throw new Error(`No owning library member for ${path}`);
  if (!isDirectoryTu(member)) return undefined;
  const part = readLibraryTu(member, root).parts.find(p => resolve(root, dirname(member.source), p.path) === resolve(root, path));
  if (!part) throw new Error(`No library TU part for ${path}`);
  return { member, part, identity: JSON.stringify({ member: member.id, original: member.sha256, part,
    functions: member.functions.map(f => [f.name, f.section, f.offset, f.size]) }) };
}
export function snapshotSource(root: string, path: string): SourceSnapshot {
  const boundary = contract(root, path)?.identity;
  return { path, text: textAt(resolve(root, path)), ...(boundary ? { boundary } : {}) };
}
async function locked<T>(paths: string[], action: () => Promise<T>): Promise<T> {
  const visit = (at: number): Promise<T> => at === paths.length ? action() : withFileMutationQueue(paths[at]!, () => visit(at + 1));
  return visit(0);
}

/** Workers never mutate live inputs. Validate their source contract BEFORE any
 * header/source write, and retain a CAS rollback until the ordinary loop has
 * settled this assignment. Exactness still belongs to the existing gate. */
export async function stageWorkerDraft(root: string, draft: WorkerDraft): Promise<WorkerPromotion> {
  if (!existsSync(draft.candidate)) return { applied: false, feedback: `Worker did not produce ${draft.candidate}` };
  const source = resolve(root, draft.source.path), text = readFileSync(draft.candidate, "utf8");
  const rejected = (error: unknown): WorkerPromotion => ({ applied: false,
    feedback: `Candidate rejected before promotion: ${String(error)}. Draft retained at ${draft.candidate}` });
  const validate = () => {
    const owner = contract(root, draft.source.path), guard = analyzeCSource(text);
    if (!guard.parses) throw new Error(`Invalid candidate C: ${guard.reasons.join("; ")}`);
    if (owner) {
      inspectLibraryPart(text, owner.part, owner.member);
      if (guard.includeAsm.some(site => site.folder !== `build/libraries/nonmatchings/${owner.member.id}`))
        throw new Error("Backlog candidate refers to another member's assembly");
    }
    if (draft.source.boundary !== owner?.identity) throw new Error("Function partition changed while the worker was running; regenerate the draft for the new assignment");
  };
  try { validate(); } catch (error) { return rejected(error); }

  const patch = !draft.headerApplied ? textAt(draft.headerPatch) : null;
  let headers: string[] = [];
  if (patch?.trim()) {
    const files = await runCommand("git", ["apply", "--numstat", "-z", draft.headerPatch], { cwd: root, timeoutMs: 120_000 });
    if (files.code !== 0) return { applied: false, feedback: `Invalid declaration patch: ${files.stderr || files.stdout}` };
    const owned = loadLibraryProject(root)?.headers.owned ?? ["include"];
    headers = files.stdout.split("\0").filter(Boolean).map(row => row.split("\t").slice(2).join("\t"));
    if (!headers.length || headers.some(p => !p.endsWith(".h") || !owned.some(d => p.startsWith(d + "/")) || p.split(/[\\/]/).includes("..")))
      return { applied: false, feedback: "Declaration patches may change only owned .h files; candidate retained privately" };
  }
  const paths = [...new Set([source, ...headers.map(p => resolve(root, p))])].sort();
  return locked(paths, async () => {
    try { validate(); } catch (error) { return rejected(error); }
    if (textAt(source) !== draft.source.text) return { applied: false,
      feedback: `Main source changed while the candidate was tested; preserved that source and retained ${draft.candidate}` };
    const before = new Map(paths.map(path => [path, textAt(path)])), headerApplied = draft.headerApplied;
    if (patch?.trim()) {
      if (textAt(draft.headerPatch) !== patch) return { applied: false, feedback: "Declaration patch changed before promotion; candidate retained" };
      try { await applyPatch(root, draft.headerPatch); }
      catch (error) { return { applied: false, feedback: `Declaration patch needs revision; candidate retained at ${draft.candidate}. ${String(error)}` }; }
    }
    const restore = () => {
      for (const [path, value] of before) {
        if (value === null) rmSync(path, { force: true });
        else writeFileSync(path, value);
      }
      if (before.has(source)) draft.source.text = before.get(source)!;
      if (headerApplied === undefined) delete draft.headerApplied;
      else draft.headerApplied = headerApplied;
    };
    // Another tool may have changed source while git was running. Never copy
    // over it, or undo its edit as part of a header rollback.
    if (textAt(source) !== before.get(source)) {
      before.delete(source); restore();
      return { applied: false, feedback: "Main source changed during declaration promotion; headers restored, source preserved" };
    }
    // git yielded to other tools; a manifest change must not make a checked
    // candidate belong to a different assignment by the time we write it.
    try { validate(); } catch (error) { restore(); return rejected(error); }
    try { mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, text); }
    catch (error) { restore(); throw error; }
    if (patch?.trim()) draft.headerApplied = true;
    draft.source.text = text;
    const after = new Map(paths.map(path => [path, textAt(path)]));
    let restored = false;
    return { applied: true, feedback: "Build candidate promoted for the main loop's ordinary verification",
      rollback: () => locked(paths, async () => {
        if (restored) return;
        const drift = paths.filter(path => textAt(path) !== after.get(path));
        if (drift.length) throw new Error(`Cannot roll back worker promotion over concurrent edits: ${drift.join(", ")}; draft retained at ${draft.candidate}`);
        restore(); restored = true;
      }) };
  });
}
