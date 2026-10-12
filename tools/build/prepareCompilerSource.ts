/** Explicit project-owned source provisioning. Never replaces cc1 or flags.
 * Source is published only when its build reproduces the configured binary. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileDigest } from "../lib/contentCache.js";
import { sourceExportRecipe, writeCompilerSourcePin } from "../lib/compilerBuildSource.js";
import { projectRoot } from "../lib/runtimeContext.js";
import { configuredTool, executablePath, loadToolchain } from "../lib/toolchain.js";
export { sourceExportRecipe } from "../lib/compilerBuildSource.js";

export function provisionCompilerSource(options: { recipe: string; destination: string; root?: string }): string {
  const root = options.root ?? projectRoot(), config = loadToolchain(root);
  if (config.compiler.family !== "gcc") throw new Error("Only the explicit GCC recipe protocol is supported");
  const recipe = resolve(root, options.recipe), destination = resolve(root, options.destination);
  if (relative(root, destination).startsWith("..") || destination === root)
    throw new Error("Compiler source destination must belong to this project");
  if (existsSync(destination)) throw new Error(`Existing source bundle is preserved: ${destination}`);
  const compiler = executablePath(configuredTool("cc1", root), root);
  if (!compiler) throw new Error("Provision the configured compiler binary before binding its source");
  const compilerHash = fileDigest(compiler), text = readFileSync(recipe, "utf8");
  const generated = sourceExportRecipe(text, config.compiler.version);
  const workRoot = join(root, "build/compiler-source-provision"); mkdirSync(workRoot, { recursive: true });
  const temporary = mkdtempSync(join(workRoot, "build-"));
  const dockerfile = join(temporary, "Dockerfile"), output = join(temporary, "export");
  writeFileSync(dockerfile, generated);
  try {
    execFileSync("docker", ["build", "--progress=plain", "--file", dockerfile, "--output", `type=local,dest=${output}`, dirname(recipe)], { cwd: root, stdio: "inherit" });
    const rebuilt = join(output, "cc1");
    if (!existsSync(rebuilt) || fileDigest(rebuilt) !== compilerHash)
      throw new Error(`Rebuilt cc1 does not match configured binary ${compilerHash}; refusing source/binary correspondence.`);
    const bundle = join(output, "compiler-source");
    writeCompilerSourcePin({ bundle, compiler, recipe, version: config.compiler.version, root, captureRecipe: generated });
    mkdirSync(dirname(destination), { recursive: true }); renameSync(bundle, destination);
    /* Compiler binaries remain ignored build artifacts, never source inputs. */
    rmSync(temporary, { recursive: true, force: true });
    return destination;
  } catch (error) {
    throw new Error(`${String(error)}\nSource provision failed; existing compiler, configuration and source bundles were not replaced. Evidence: ${temporary}`);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "prepareCompilerSource.ts") {
  const args = process.argv.slice(2), option = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes("--recipe") || !args.includes("--destination")) {
    console.error("Usage: prepareCompilerSource.ts --recipe PROJECT_DOCKERFILE --destination PROJECT_SOURCE_BUNDLE"); process.exitCode = 1;
  } else {
    console.log(provisionCompilerSource({ recipe: option("--recipe")!, destination: option("--destination")! }));
  }
}
