/**
 * The harness that compiles, compares and audits a library member: the module
 * closure of the verification entry points, plus the runtime data those modules
 * read. A library acceptance record is keyed on these files, so an edit
 * anywhere else in the harness (diagnostics, tests, preparation-only tools)
 * leaves every record standing, while an edit on the verification path still
 * re-verifies every member (plans/optimization/02-verification-key.md).
 *
 * Imports are followed statically, including literal dynamic imports. The
 * closure-completeness test (tools/lib/verificationClosure.test.ts) runs a real
 * member check and fails on any harness module or file it loads that this
 * closure does not name.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { fileDigest, filesUnder } from "./contentCache.js";

/** Where a member check starts: the check itself and the processes that host it. */
export const VERIFICATION_ENTRY_POINTS = [
  "tools/agent/libraryTarget.ts",
  "tools/agent/library.ts",
  "tools/agent/libraryFinalizeGate.ts",
  "tools/lib/scriptHost.ts",
];
/** Data the verification modules read at run time, beside their own source. */
export const VERIFICATION_RUNTIME_DATA = ["tools/vendor/tree-sitter-c", "package-lock.json"];

/* Recomputed only when a module of the previous closure changed: an edit that
   adds an import edits a module already in the closure. */
const closures = new Map<string, { modules: string[]; contents: string; closure: string[] }>();
function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, base.replace(/\.mjs$/, ".mts")].find(path => /\.m?[jt]s$/.test(path) && existsSync(path));
}
const contentsOf = (modules: string[]) => modules.map(path => fileDigest(path)).join("\n");

/** Harness-relative paths, sorted: every module in the closure, then the runtime data files. */
export function verificationClosure(harnessRoot: string): string[] {
  const key = resolve(harnessRoot), prior = closures.get(key);
  if (prior && contentsOf(prior.modules) === prior.contents) return prior.closure;
  const modules = new Set<string>();
  const visit = (path: string) => {
    if (modules.has(path) || !existsSync(path)) return;
    modules.add(path);
    for (const imported of ts.preProcessFile(readFileSync(path, "utf8"), true, true).importedFiles) {
      const target = resolveImport(path, imported.fileName);
      if (target) visit(target);
    }
  };
  for (const entry of VERIFICATION_ENTRY_POINTS) visit(join(key, entry));
  const data = VERIFICATION_RUNTIME_DATA.flatMap(path => filesUnder(join(key, path)));
  const closure = [...new Set([...modules, ...data])].map(path => relative(key, path)).sort();
  closures.set(key, { modules: [...modules], contents: contentsOf([...modules]), closure });
  return closure;
}
