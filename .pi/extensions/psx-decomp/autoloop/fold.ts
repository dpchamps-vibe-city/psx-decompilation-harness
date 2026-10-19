/** Auto-fold after a match: a library member whose every part is now final
 * folds into one module. The fold runs out of process, re-verifies the member
 * and rolls back on any mismatch; a member that is not ready is left alone. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { libraryMemberById, libraryTargetKey, requireLibraryFunction } from "../../../../tools/lib/libraryTargets.js";
import { libraryModulePart, libraryTuStatus } from "../../../../tools/lib/libraryTranslationUnit.js";
import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";
import { FOLD_STATUS, foldRefusal, recordFoldCleanup, type FoldReport } from "../../../../tools/agent/foldLibraryTu.js";
import { runCommand } from "../../shared/process.ts";
import { workspaceChangedFiles } from "../../shared/workspace.ts";
import { runGate } from "../../shared/gates.ts";
import { loadConfig } from "../../shared/config.ts";
import { foldCleanupMessage } from "./prompts.ts";

export interface FoldOutcome { memberId: string; written: boolean; module?: string; directory?: string; error?: string }

export async function foldMatchedMember(projectRoot: string, target: string, run: typeof runCommand = runCommand): Promise<FoldOutcome> {
  const { member } = requireLibraryFunction(target, projectRoot);
  /* The fold command's own first step: a member that cannot fold yet is
     refused before anything is staged, so the refusal needs no process. */
  if (foldRefusal(member, projectRoot)) return { memberId: member.id, written: false };
  const result = await run(process.execPath, installedScriptArgs("tools/agent/library.ts", ["fold", "--member", member.id, "--write", "--json"], projectRoot),
    { cwd: projectRoot, timeoutMs: 900_000 });
  const line = result.stdout.split("\n").reverse().find(l => l.startsWith(FOLD_STATUS));
  let report: FoldReport | undefined;
  try { report = line ? JSON.parse(line.slice(FOLD_STATUS.length)) as FoldReport : undefined; } catch { report = undefined; }
  const row = report?.members[0];
  if (!row) return { memberId: member.id, written: false, error: (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${result.code}` };
  if (row.refused) return { memberId: member.id, written: false };
  return { memberId: member.id, written: row.written === true, module: row.module, directory: dirname(member.source), ...(row.written ? {} : { error: `module ${row.verdict ?? "not built"}` }) };
}


export interface FoldCleanupOutcome { memberId: string; status: "passed" | "failed"; changed: boolean; changedFiles: string[]; error?: string }

/**
 * One cleanup turn on a folded module, then the refinement gate.
 *
 * The turn may edit the module and nothing else: anything else it touched is
 * restored and the cleanup fails. A cleanup is kept only when the module is
 * still a valid fold and the gate passes (source policy, every function's byte
 * diff, the member and every previously verified member). Otherwise the module
 * and manifest go back to the verbatim fold, whose verification still stands.
 */
export async function runFoldCleanup(options: { projectRoot: string; memberId: string; turn: (message: string) => Promise<true | string>; signal?: AbortSignal }): Promise<FoldCleanupOutcome> {
  const root = options.projectRoot, member = libraryMemberById(options.memberId, root), module = libraryModulePart(member, root);
  if (!module) return { memberId: member.id, status: "failed", changed: false, changedFiles: [], error: "not a folded module" };
  const modulePath = join(dirname(member.source), module.path), manifestPath = member.source;
  const changedBefore = new Set(await workspaceChangedFiles(root));
  const snapshot = new Map([...changedBefore, modulePath, manifestPath].map(file => [file, existsSync(resolve(root, file)) ? readFileSync(resolve(root, file)) : null]));
  const fold = snapshot.get(modulePath)!, manifest = snapshot.get(manifestPath)!;
  const fail = (error: string): FoldCleanupOutcome => {
    writeFileSync(resolve(root, modulePath), fold); writeFileSync(resolve(root, manifestPath), manifest);
    return { memberId: member.id, status: "failed", changed: false, changedFiles: [], error };
  };
  let outcome: true | string;
  try { outcome = await options.turn(foldCleanupMessage(member.id, modulePath, `${basename(member.input)} ${member.member}`)); }
  catch (error) { outcome = String(error); }
  const outside = await restoreOutside(root, snapshot, changedBefore, modulePath);
  if (outside.length) return fail(`edited outside the module (restored): ${outside.join(", ")}`);
  if (outcome !== true) return fail(outcome);
  try { libraryTuStatus(member, root); } catch (error) { return fail(`the module is no longer a valid fold: ${error instanceof Error ? error.message : error}`); }
  const changed = !readFileSync(resolve(root, modulePath)).equals(fold);
  recordFoldCleanup(member, root);
  const keys = member.functions.map(fn => libraryTargetKey(member, fn.name));
  const gate = await runGate({ projectRoot: root, config: loadConfig(root), mode: "project-refinement", changedFiles: [modulePath, manifestPath], patch: "", runBuild: true,
    functionSources: Object.fromEntries(keys.map(key => [key, modulePath])), functionContainers: Object.fromEntries(keys.map(key => [key, member.id])),
    ...(options.signal ? { signal: options.signal } : {}) });
  if (!gate.pass) return fail(`refinement gate failed: ${gate.failures.join("; ").slice(0, 2000)}`);
  return { memberId: member.id, status: "passed", changed, changedFiles: [modulePath, manifestPath] };
}

/** Put back every path the turn changed other than the module: snapshot files
 * byte for byte, newly touched tracked files from git, new files removed. */
async function restoreOutside(root: string, snapshot: Map<string, Buffer | null>, changedBefore: Set<string>, modulePath: string): Promise<string[]> {
  const restored: string[] = [];
  for (const file of new Set([...changedBefore, ...await workspaceChangedFiles(root), ...snapshot.keys()])) {
    if (file === modulePath) continue;
    const path = resolve(root, file), current = existsSync(path) ? readFileSync(path) : null;
    if (snapshot.has(file)) {
      const original = snapshot.get(file)!;
      if (original === null ? current === null : current !== null && current.equals(original)) continue;
      if (original === null) rmSync(path, { force: true }); else writeFileSync(path, original);
    } else if ((await runCommand("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root, timeoutMs: 30_000 })).code === 0) {
      await runCommand("git", ["checkout", "--", file], { cwd: root, timeoutMs: 30_000 });
    } else rmSync(path, { force: true, recursive: true });
    restored.push(file);
  }
  return restored;
}
