/** Dependency discovery is metadata only. Its stdout never feeds cc1/as. The
 * baseline -M/-MG protocol is supported by period cccp as well as modern cpp. */
import { execFileSync } from "node:child_process";
import { configuredDependencyScanner, executablePath } from "./toolchain.js";
import { fileDigest } from "./contentCache.js";
import { projectRoot } from "./runtimeContext.js";
import { resolve } from "node:path";
import { count } from "./perfCounters.js";
export function dependencyPaths(text: string, root: string): string[] {
  const first = text.replace(/\\\r?\n/g, " ").split("\n")[0] ?? "";
  const colon = first.indexOf(":");
  if (colon < 0) throw new Error("cpp did not emit a dependency rule");
  return (first.slice(colon + 1).match(/(?:\\.|[^\s])+/g) ?? []).map(p => resolve(root, p.replace(/\\(.)/g, "$1")));
}
export function dependencyScannerIdentity(root = projectRoot()) {
  const command = configuredDependencyScanner(root), path = executablePath(command, root);
  if (!path) throw new Error(`Dependency scanner not found: ${command}`);
  return { command, path, sha256: fileDigest(path) };
}
export function scanDependencies(input: string, flags: string[], root = projectRoot()): string {
  count("spawn"); count("spawn:dependency-scan");
  return execFileSync(configuredDependencyScanner(root), [...flags, "-M", "-MG", input],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
