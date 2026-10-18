/** Acceptance records identify the bytes that execute, not launcher names. */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileDigest } from "./contentCache.js";
import { configuredTool, configuredCppFrontend, configuredCompilerSource, executablePath, loadToolchain, type ToolName, type FlagContext } from "./toolchain.js";
import { contextForProject, inRuntimeContext, projectRoot, resolveOwnedPath } from "./runtimeContext.js";
import { assemblerIdentity } from "./assembler.js";
import { verifyCompilerBinding } from "../agent/compiler-source/index.js";
const linked = new Map<string, string[]>();
export function executedToolIdentity(name: ToolName, root = projectRoot(), command = configuredTool(name, root, { prepare: false })) {
  const path = executablePath(command, root);
  if (!path) throw new Error(`Missing executed tool ${name}: ${command}`);
  const sha256 = fileDigest(path), bytes = readFileSync(path), key = [sha256, path, process.env.LD_LIBRARY_PATH ?? "", process.env.LD_PRELOAD ?? ""].join("\0");
  let dependencies = linked.get(key);
  if (!dependencies) {
    dependencies = [];
    if (bytes.toString("hex", 0, 4) === "7f454c46") {
      const result = spawnSync("ldd", [path], { encoding: "utf8" });
      const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (/not found/.test(text)) throw new Error(`${name}: unresolved linked library: ${text.trim()}`);
      if (result.error || (result.status !== 0 && !/not a dynamic executable|statically linked/.test(text))) throw new Error(`${name}: cannot identify linked libraries: ${text.trim()}`);
      dependencies = [...new Set([...text.matchAll(/(?:=>\s*|^\s*)(\/[^\s]+)\s+\(/gm)].map(m => m[1]!))].sort();
    }
    linked.set(key, dependencies);
  }
  return { path, sha256, dependencies: dependencies.map(path => { if (!existsSync(path)) throw new Error(`Missing linked library ${path}`); return { path, sha256: fileDigest(path) }; }) };
}
export function acceptanceToolchain(root = projectRoot(), context?: FlagContext, requirePins = false) {
  const config = loadToolchain(root), tools = Object.fromEntries((["cpp", "cc1", "as"] as const).map(name => [name, executedToolIdentity(name, root)]));
  const recipes: Record<string, unknown> = {};
  for (const [name, pin] of Object.entries(config.toolPins ?? {})) {
    const actual = executedToolIdentity(name as ToolName, root);
    if (actual.sha256 !== pin!.sha256) throw new Error(`Pinned ${name} hash mismatch: ${actual.sha256} != ${pin!.sha256}`);
    if (pin!.recipe) {
      const recipe = resolveOwnedPath(pin!.recipe, contextForProject(root));
      if (fileDigest(recipe) !== pin!.recipeSha256) throw new Error(`Pinned ${name} recipe changed: ${recipe}`);
      recipes[name] = { recipe, sha256: pin!.recipeSha256 };
    }
  }
  if (requirePins) for (const name of ["cpp", "cc1", "as", ...(config.tools.cppFrontend ? ["cppFrontend"] : [])] as ToolName[]) if (!config.toolPins?.[name]) throw new Error(`Original-object acceptance requires a ${name} tool pin`);
  let compilerBinding: unknown = { status: "not-configured" };
  if (configuredCompilerSource(root)) {
    compilerBinding = inRuntimeContext(contextForProject(root), () => verifyCompilerBinding());
    if ((compilerBinding as any).status !== "verified") throw new Error("Configured compiler source has no verified binary binding");
    const pin = join(configuredCompilerSource(root)!, "pin.json"); recipes.cc1SourcePin = { path: pin, sha256: fileDigest(pin) };
  }
  const assembler = assemblerIdentity(context, root);
  const cppFrontend = config.tools.cppFrontend ? configuredCppFrontend(root) : null;
  return { cpp: tools.cpp, cc1: tools.cc1, as: tools.as, recipes, compilerBinding, objectFormat: assembler.objectFormat, stages: assembler.stages, ...(assembler.lnkLayout ? { lnkLayout: assembler.lnkLayout } : {}),
    ...(cppFrontend ? { cppFrontend: executedToolIdentity("cppFrontend", root) } : {}),
    ...(assembler.kind === "maspsx" ? { maspsx: (assembler as any).maspsx, python: executedToolIdentity("python", root) } : {}) };
}
