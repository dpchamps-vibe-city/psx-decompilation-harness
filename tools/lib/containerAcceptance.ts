/** Function scores are diagnostic. Publication requires the production whole
 * container/member gate with the candidate installed transactionally. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { installedScriptArgs } from "./installedScripts.js";
import { projectRoot } from "./runtimeContext.js";
import { loadLibraryProject } from "./project.js";
import { resolveFunctionTarget } from "./targetAdapter.js";
export function checkCandidateContainer(functionName: string, patches: Array<{ path: string; after: string }> = [], root = projectRoot()): void {
  const library = loadLibraryProject(root), target = resolveFunctionTarget(functionName, root);
  const seen = new Set<string>();
  const snapshots = patches.map(p => {
    const path = resolve(root, p.path), rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep) || seen.has(path)) throw new Error(`Unsafe/duplicate acceptance patch: ${p.path}`);
    seen.add(path);
    let cursor = root;
    for (const part of rel.split(sep)) { cursor = resolve(cursor, part); if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Acceptance patch follows symlink: ${p.path}`); }
    return { path, before: existsSync(path) ? readFileSync(path) : null, after: p.after };
  });
  try {
    for (const p of snapshots) { mkdirSync(dirname(p.path), { recursive: true }); writeFileSync(p.path, p.after); }
    const script = library ? "tools/agent/library.ts" : "tools/build/pipeline.ts";
    const args = library ? ["check", "--member", target.owner.id] : ["check-all"];
    execFileSync(process.execPath, installedScriptArgs(script, args, root), { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    throw new Error(`Full container acceptance unavailable or failed for ${functionName}: ${String(error)}\n${output}`);
  }
  finally { for (const p of snapshots.reverse()) { if (p.before === null) rmSync(p.path, { force: true }); else writeFileSync(p.path, p.before); } }
}
