/** Content identity for builds and verification receipts, including executable
 * contents, configuration, environment and include search membership. */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { digest, filesUnder, snapshot, writeIfChanged } from "../lib/contentCache.js";
import { configuredTool, executablePath, loadToolchain, TOOLCHAIN_FILE, toolchainExecutables } from "../lib/toolchain.js";

export function buildToolInputs(root: string): string[] {
  const paths = Object.values(toolchainExecutables(root)).flatMap(tool => tool.path ? [tool.path] : []);
  // GCC cpp is a driver: its frontend is a separate binary that also invalidates
  // builds. Other preprocessors may not implement this query.
  if (loadToolchain(root).compiler.family === "gcc") {
    const cpp = configuredTool("cpp", root);
    const frontend = execFileSync(cpp, ["-print-prog-name=cc1"], { cwd: root, encoding: "utf8" }).trim();
    const path = executablePath(frontend, root);
    if (path) paths.push(path);
  }
  return [...paths, TOOLCHAIN_FILE, "package.json", "package-lock.json", "tools/build/pipeline.ts", "tools/build/buildInputs.ts",
    "tools/lib/toolchain.ts", "tools/lib/contentCache.ts", "tools/agent/decompToolchain.ts", "tools/agent/preprocessedCache.ts",
    join(dirname(configuredTool("maspsx", root)), "maspsx")];
}
export function buildInputIdentity(root: string, values: string[] = []): string {
  const config = loadToolchain(root);
  const state = snapshot(root, buildToolInputs(root), p => !p.includes("/.git/") && !p.endsWith(".pyc"));
  const environment = Object.fromEntries(["PATH", "CPATH", "C_INCLUDE_PATH", "GCC_EXEC_PREFIX", "COMPILER_PATH", "SOURCE_DATE_EPOCH", "PYTHONPATH"]
    .map(p => [p, process.env[p] ?? null]));
  const membership = config.includeDirs.map(p => [p, filesUnder(resolve(root, p))]);
  return digest(JSON.stringify({ state, values, environment, membership, tools: toolchainExecutables(root) }));
}
export function refreshBuildInputs(root: string, values: string[] = []): boolean {
  return writeIfChanged(join(root, "build/toolchain-inputs.stamp"), buildInputIdentity(root, values) + "\n");
}
if (process.argv[1]?.endsWith("buildInputs.ts")) refreshBuildInputs(resolve("."), process.argv.slice(2));
