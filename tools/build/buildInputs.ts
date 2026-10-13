/** Content identity for builds and verification receipts, including executable
 * contents, configuration, environment and include search membership. */
import { contextForProject } from "../lib/runtimeContext.js";
import { dirname, join, resolve } from "node:path";
import { digest, filesUnder, snapshot, writeIfChanged } from "../lib/contentCache.js";
import { configuredCppFrontend, loadToolchain, TOOLCHAIN_FILE, toolchainExecutables } from "../lib/toolchain.js";

export function buildToolInputs(root: string): string[] {
  const tools = toolchainExecutables(root);
  const paths = Object.values(tools).flatMap(tool => tool.path ? [tool.path] : []);
  const frontend = configuredCppFrontend(root);
  if (frontend) paths.push(frontend);
  const implementation = ["tools/build/pipeline.ts", "tools/build/buildInputs.ts", "tools/lib/toolchain.ts", "tools/lib/assembler.ts",
    "tools/lib/contentCache.ts", "tools/agent/decompToolchain.ts", "tools/agent/preprocessedCache.ts"];
  return [...paths, TOOLCHAIN_FILE, "package.json", "package-lock.json", ...implementation.map(path => join(contextForProject(root).harnessRoot, path)),
    ...(tools.maspsx?.path ? [join(dirname(tools.maspsx.path), "maspsx")] : [])];
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
