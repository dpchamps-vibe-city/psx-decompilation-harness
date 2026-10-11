import { projectRoot } from "../../lib/runtimeContext.js";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runTool } from "../decompToolchain.js";
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
  const root = join(projectRoot(), "build/compilerOracle");
  const contextDirectory = join(root, "context");
  mkdirSync(contextDirectory, { recursive: true });
  const local = instrumentLocalAllocation();
  const scheduler = instrumentScheduler();
  const dockerfile = diagnosticDockerfile();
  const buildId = sha256(local + "\0" + scheduler + "\0" + dockerfile).slice(0, 16);
  writeFileSync(join(contextDirectory, "local-alloc.c"), local);
  writeFileSync(join(contextDirectory, "sched.c"), scheduler);
  writeFileSync(join(root, "Dockerfile"), dockerfile);
  writeFileSync(join(contextDirectory, "identity.txt"), `${buildId}\n`);
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
    "--target", "export", "--output", output, projectRoot(),
  ], projectRoot());
  if (!existsSync(compiler)) throw new Error(`Diagnostic compiler build did not produce ${compiler}`);
  writeFileSync(identity, `${prepared.buildId}\n`);
  return { compiler, buildId: prepared.buildId, rebuilt: true, contextDirectory: prepared.contextDirectory };
}
