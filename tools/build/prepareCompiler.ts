/** Build the supported public compiler recipe into the project dependency cache.
 * Never download SDK inputs or modify installed sources. Custom compilers remain
 * explicit configuration; only the exact supported runtime location is eligible. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contextForProject } from "../lib/runtimeContext.js";
import { fileDigest, filesUnder, digest } from "../lib/contentCache.js";
export function prepareSupportedCompiler(root: string): string {
  const context = contextForProject(root), recipe = join(context.harnessRoot, "tools/vendor/old-gcc/gcc-2.95.2-psx.Dockerfile");
  const destination = join(context.runtimeRoot, "dependencies/compiler/gcc-2.95.2-psx"), compiler = join(destination, "cc1");
  if (existsSync(compiler)) return compiler;
  const inputs = [recipe, ...filesUnder(join(dirname(recipe), "patches")), ...filesUnder(join(dirname(recipe), "tests"))];
  const recipeHash = digest(JSON.stringify(inputs.map(path => [path.slice(dirname(recipe).length), fileDigest(path)])));
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), "compiler-build-"));
  try {
    execFileSync("docker", ["build", "--file", recipe, "--output", `type=local,dest=${temporary}`, dirname(recipe)], { cwd: root, stdio: "inherit" });
    if (!existsSync(join(temporary, "cc1"))) throw new Error("Supported recipe produced no cc1");
    const probe = execFileSync(join(temporary, "cc1"), ["-version"], { input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(join(temporary, "compiler-provenance.json"), JSON.stringify({ schemaVersion: 1, version: "2.95.2-psx", recipeHash, compilerHash: fileDigest(join(temporary, "cc1")), probe }) + "\n");
    if (existsSync(destination)) throw new Error(`Incomplete compiler cache is preserved: ${destination}`);
    renameSync(temporary, destination);
    return compiler;
  } catch (error) {
    throw new Error(`Cannot provision the supported GCC compiler into ${destination}. Supply Docker/BuildKit and re-run, or explicitly configure your compiler executable. No SDK download or installed-source write was attempted. ${String(error)}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
