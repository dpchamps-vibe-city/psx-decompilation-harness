import { projectRoot, harnessRoot } from "../../lib/runtimeContext.js";
import { createHash } from "crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { runTool, configuredGccVersion } from "../decompToolchain.js";
import { requireCompilerCapability } from "../../lib/toolchain.js";
import { fileDigest, filesUnder } from "../../lib/contentCache.js";
import { loadPin, vendorDir, verifyCompilerBinding, verifyTree } from "../compiler-source/index.js";
import { diagnosticDockerfile, instrumentLocalAllocation, instrumentScheduler } from "./instrumentation.js";

export interface DiagnosticCompilerBuild {
  compiler: string;
  buildId: string;
  rebuilt: boolean;
  contextDirectory: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function diagnosticCompilerPath(): string {
  return join(projectRoot(), "build/compilerOracle/compiler/cc1");
}

export function prepareDiagnosticCompilerContext(): { buildId: string; contextDirectory: string } {
  requireCompilerCapability("gcc-rtl-dumps");
  const pin = loadPin();
  const binding = verifyCompilerBinding();
  if (binding.status !== "verified")
    throw new Error("Compiler-oracle requires a source pin bound to the configured compiler binary; no substitute compiler will be built.");
  const tree = verifyTree();
  if (!tree.ok) throw new Error("Compiler-oracle source tree differs from its pin; re-provision the configured source.");
  const bundle = vendorDir();
  // Captured bundles carry their recipe. Older pins name its project/package
  // path explicitly; neither path is chosen by compiler release.
  const recipePath = [resolve(bundle, pin.correspondsTo.recipe),
    resolve(projectRoot(), pin.correspondsTo.recipe), resolve(harnessRoot(), pin.correspondsTo.recipe)]
    .find(path => existsSync(path));
  if (!recipePath) throw new Error(`Compiler-oracle configured build recipe is missing: ${pin.correspondsTo.recipe}`);
  const contextFiles = [recipePath, ...filesUnder(join(dirname(recipePath), "patches")), ...filesUnder(join(dirname(recipePath), "tests"))];
  const contextHash = sha256(JSON.stringify(contextFiles.map(file => [relative(dirname(recipePath), file), fileDigest(file)]).sort()));
  if (pin.build && (fileDigest(recipePath) !== pin.build.recipeSha256 || contextHash !== pin.build.contextSha256))
    throw new Error("Compiler-oracle build recipe/context differs from the configured source pin.");
  const dockerfile = diagnosticDockerfile(readFileSync(recipePath, "utf8"), configuredGccVersion(), pin.upstream.sha256);
  let local: string, scheduler: string;
  try {
    local = instrumentLocalAllocation();
    scheduler = instrumentScheduler();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Instrumentation needs a port to the configured source; native RTL, scheduler and loop diagnostics remain available.`);
  }
  const root = join(projectRoot(), "build/compilerOracle");
  const contextDirectory = join(root, "context");
  rmSync(contextDirectory, { recursive: true, force: true });
  mkdirSync(contextDirectory, { recursive: true });
  for (const directory of ["patches", "tests"]) {
    const input = join(dirname(recipePath), directory);
    if (existsSync(input)) cpSync(input, join(contextDirectory, directory), { recursive: true });
  }
  const provenance = { compilerSha256: binding.actual, sourcePinSha256: fileDigest(join(bundle, "pin.json")),
    sourceTreeSha256: tree.actual, recipeSha256: fileDigest(recipePath), contextSha256: contextHash };
  const buildId = sha256(JSON.stringify(provenance) + "\0" + local + "\0" + scheduler + "\0" + dockerfile).slice(0, 16);
  writeFileSync(join(contextDirectory, "local-alloc.c"), local);
  writeFileSync(join(contextDirectory, "sched.c"), scheduler);
  writeFileSync(join(root, "Dockerfile"), dockerfile);
  writeFileSync(join(contextDirectory, "identity.txt"), `${buildId}\n`);
  writeFileSync(join(contextDirectory, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  return { buildId, contextDirectory };
}

export function buildDiagnosticCompiler(force = false): DiagnosticCompilerBuild {
  const prepared = prepareDiagnosticCompilerContext();
  const compiler = diagnosticCompilerPath();
  const identity = join(projectRoot(), "build/compilerOracle/compiler/identity.txt");
  if (!force && existsSync(compiler) && existsSync(identity)
      && readFileSync(identity, "utf8").trim() === prepared.buildId) {
    return { compiler, buildId: prepared.buildId, rebuilt: false, contextDirectory: prepared.contextDirectory };
  }

  const output = join(projectRoot(), "build/compilerOracle/compiler");
  mkdirSync(output, { recursive: true });
  runTool("docker", [
    "build", "--file", join(projectRoot(), "build/compilerOracle/Dockerfile"),
    "--target", "export", "--output", output, prepared.contextDirectory,
  ], projectRoot());
  if (!existsSync(compiler)) throw new Error(`Diagnostic compiler build did not produce ${compiler}`);
  writeFileSync(identity, `${prepared.buildId}\n`);
  return { compiler, buildId: prepared.buildId, rebuilt: true, contextDirectory: prepared.contextDirectory };
}
