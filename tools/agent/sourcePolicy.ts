#!/usr/bin/env npx tsx
import { projectRoot } from "../lib/runtimeContext.js";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../.pi/extensions/shared/config.ts";
import { loadCallGraph } from "../../.pi/extensions/shared/call-graph.ts";
import { checkSourcePolicy, isPendingStub } from "../../.pi/extensions/shared/source-policy.ts";
import {
  changedFilesBetweenTrees,
  createTreeFromWorktree,
  treePatch,
  workspaceChangedFiles,
} from "../../.pi/extensions/shared/workspace.ts";



async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const functionIndex = args.indexOf("--function");
  const functionName = functionIndex >= 0 ? args[functionIndex + 1] : undefined;
  const config = loadConfig(projectRoot());
  const tree = await createTreeFromWorktree(projectRoot(), projectRoot(), config.integration.allowedRoots);
  const patch = await treePatch(projectRoot(), "HEAD", tree, config.integration.allowedRoots);
  const changedFiles = [...new Set([
    ...await changedFilesBetweenTrees(projectRoot(), "HEAD", tree),
    ...await workspaceChangedFiles(projectRoot()),
  ])].sort();
  const graph = loadCallGraph(projectRoot());
  const entry = functionName ? graph.functions.find((candidate) => candidate.name === functionName) : undefined;
  if (functionName && !entry) throw new Error(`Unknown function: ${functionName}`);
  /* --final reproduces the controller's completion audit, where every live
   * function must be real C and a leftover INCLUDE_ASM stub is a failure. The
   * default repo-wide sweep is a mid-project diagnostic: it audits the
   * functions that claim to be decompiled and skips the undecompiled backlog,
   * whose stubs are the expected state rather than folded assembly. */
  const finalAudit = args.includes("--final");
  const live = graph.functions.filter((candidate) => !candidate.dead && candidate.handwritten !== "asm");
  const candidates = functionName ? [functionName] : live.map((candidate) => candidate.name);
  /* The call graph places each function's translation unit. Reconstructing
     `src/<name>.c` here would look past every overlay's source directory, and a
     file that is not there reads as a function with no stub to skip. */
  const sourceOf = new Map(graph.functions.map((candidate) => [candidate.name, candidate.source ?? `src/${candidate.name}.c`]));
  const pendingStubs = functionName || finalAudit
    ? []
    : candidates.filter((name) => {
      const path = resolve(projectRoot(), sourceOf.get(name) ?? `src/${name}.c`);
      return existsSync(path) && isPendingStub(readFileSync(path, "utf8"));
    });
  const pending = new Set(pendingStubs);
  const scanFunctions = candidates.filter((name) => !pending.has(name));
  /* Changed backlog files (a fresh split, a park, a reformed member) are the
     same canonical extraction stubs: skipped like pending functions, audited by --final. */
  const backlogFiles = new Set(finalAudit ? [] : changedFiles.filter(file => file.endsWith(".c") && existsSync(resolve(projectRoot(), file)) &&
    isPendingStub(readFileSync(resolve(projectRoot(), file), "utf8"))));
  const auditedPatch = patch.split(/(?=^diff --git )/m).filter(section => !backlogFiles.has(/^diff --git a\/(\S+)/.exec(section)?.[1] ?? "")).join("");
  const result = checkSourcePolicy({
    projectRoot: projectRoot(),
    config,
    ...(functionName ? { functionName } : {}),
    ...(entry?.vram ? { functionVram: entry.vram } : {}),
    ...(entry?.container ? { functionContainer: entry.container } : {}),
    scanFunctions,
    functionVrams: Object.fromEntries(graph.functions.map((candidate) => [candidate.name, candidate.vram])),
    functionContainers: Object.fromEntries(graph.functions.map((candidate) => [candidate.name, candidate.container])),
    functionSources: Object.fromEntries(sourceOf),
    changedFiles: changedFiles.filter(file => !backlogFiles.has(file)),
    patch: auditedPatch,
  });

  /* Worker containment ("did this patch touch anything outside the integration
   * roots?") is the controller's concern, not this diagnostic's: run by hand
   * with unrelated tooling edits in the tree it reports the tree, not a source
   * defect. Report those, but judge the run on the source findings. */
  const sourceFailures = result.hardFailures.filter((finding) => finding.kind !== "out-of-scope");
  const pass = sourceFailures.length === 0;
  const scope = `${scanFunctions.length} function(s) scanned`
    + (pendingStubs.length > 0 ? `, ${pendingStubs.length} undecompiled stub(s) skipped — rerun with --final to audit them` : "");

  if (args.includes("--json")) console.log(JSON.stringify({ ...result, pass, scanFunctions, pendingStubs, finalAudit }, null, 2));
  else {
    if (pass) console.log(`Source policy passed (${scope}).`);
    else {
      console.error(`Source policy failed (${scope}):`);
      for (const finding of sourceFailures) {
        console.error(`  ${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.kind}: ${finding.message}`);
      }
    }
    for (const warning of result.warnings) console.log(`Warning: ${warning.file}${warning.line ? `:${warning.line}` : ""}: ${warning.message}`);
    if (result.outOfScopeFiles.length > 0) {
      console.log(`Note: ${result.outOfScopeFiles.length} changed file(s) outside the integration roots (not a source-policy failure here):`);
      for (const file of result.outOfScopeFiles) console.log(`  ${file}`);
    }
  }
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
