import { projectRoot } from "../lib/runtimeContext.js";
import { assemble, assembleAsync, assemblerIdentity, captureAssemblerExpansion as captureExpansion } from "../lib/assembler.js";
export type { AssemblerExpansion } from "../lib/assembler.js";
import { execFileSync, spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { Container } from "../lib/container.js";
import { imageContainerFor, resolveFunctionTarget, requireTargetCapability, sourceFlagContext } from "../lib/targetAdapter.js";
import { objectFunctions, readRelocatableObject } from "../lib/relocatableObject.js";

import { configuredAssemblerConfig, configuredFlags, configuredTool, configuredCompilerAnalysis, executablePath, loadToolchain, requireCompilerCapability, toolchainDigest, toolchainExecutables } from "../lib/toolchain.js";
export { configuredTool } from "../lib/toolchain.js";
import { loadLibraryProject, libraryContext } from "../lib/project.js";
import { requireLibraryFunction, libraryMemberById } from "../lib/libraryTargets.js";
import { extractSignaturesFromSource } from "./sdkTypes.js";
import { isDirectoryTu, libraryAssemblyDependencies, libraryAssemblyTu, libraryFunctionSource, libraryCompileInput, libraryDependencyInput, librarySourceFiles, type LibraryAssemblyTu } from "../lib/libraryTranslationUnit.js";
export function productionCompileInput(source: string, output: string, context: FlagContext, stem = "", root = projectRoot()): string {
  if (context.kind !== "library" || !context.id || source.endsWith(".h")) return source;
  const member = libraryMemberById(context.id!, root);
  const symbol = stem.match(/^lib_[a-f0-9]{16}_\d+::([A-Za-z_]\w*)(?:\.|$)/)?.[1];
  if (isDirectoryTu(member) && !symbol && resolve(root, source) !== resolve(root, member.source) &&
      !member.functions.some(fn => resolve(root, libraryFunctionSource(member, fn.name)) === resolve(root, source)) &&
      !extractSignaturesFromSource(readFileSync(resolve(root, source), "utf8")).some(s => member.functions.some(fn => fn.name === s.name))) return source; // standalone header/SDK encoding probe, not a target candidate
  return libraryCompileInput(member, source, output, root, symbol);
}
import { compilerAssemblyOrigin, objectFunctionView, projectCompilerArtifacts, resetCompilerArtifacts, writeObjectFunctionView } from "../lib/compilerArtifacts.js";
import type { FlagContext } from "../lib/toolchain.js";
import { readFlagOverrides } from "../lib/flagOverrides.js";
function compilationContext(stem: string, kind?: FlagContext["kind"], id?: string): FlagContext {
  if (kind === "library") return libraryContext(id ?? "");
  if (kind) return { kind, ...(id ? { id } : {}) };
  if (!stem && !loadLibraryProject()) return { kind: kind ?? "exe", id: "exe" };
  const scoped = stem.match(/^(lib_[a-f0-9]{16}_\d+::[A-Za-z_]\w*)(?:\.|$)/);
  return resolveFunctionTarget(scoped?.[1] ?? stem).flags;
}
function overrideKey(stem: string, context: FlagContext): string {
  return context.kind === "library" ? context.id! : stem;
}



/** Compatibility API for GCC analyses; configuration is not original-game evidence. */
export function configuredGccVersion(): string {
  const compiler = loadToolchain().compiler;
  if (compiler.family !== "gcc") throw new Error(`GCC analysis is unavailable for ${compiler.family}`);
  return compiler.version;
}
export function configuredCompilerPath(): string { return configuredTool("cc1"); }
export function configuredCppFlags(): string[] { return configuredFlags("cpp"); }
export function configuredCc1Flags(): string[] { return configuredFlags("cc1"); }
export function configuredCc1FlagsForContainer(kind: FlagContext["kind"], id?: string): string[] {
  return configuredFlags("cc1", kind === "library" ? libraryContext(id ?? "") : { kind, ...(id ? { id } : {}) });
}
export function configuredAsFlagsForContainer(kind: FlagContext["kind"], id?: string): string[] {
  return configuredFlags("as", kind === "library" ? libraryContext(id ?? "") : { kind, ...(id ? { id } : {}) });
}
export function configuredAsFlags(): string[] { return configuredFlags("as"); }

/** Legacy read-only exports remain live across configuration edits. */
function liveFlags(read: () => string[]): string[] {
  return new Proxy([] as string[], { get(_target, property) {
    const current = read();
    const value = Reflect.get(current, property);
    return typeof value === "function" ? value.bind(current) : value;
  } });
}
export const CPP_FLAGS = liveFlags(configuredCppFlags);

/**
 * The container that defines a symbol, derived from the symbol itself.
 *
 * Overlay symbols carry their container id as a prefix and the executable's do
 * not, so the name settles the question and no caller has to name a container.
 * That is the point: an agent working one function should never need to know
 * which binary it is in — its source path, its original assembly and its
 * compiler flags all resolve from here.
 *
 * Answers `null`, never a guess, when the container model cannot be loaded at
 * all (an unconfigured tree, a fixture), so callers fall back to the
 * single-binary layout rather than failing.
 */
export function containerForSymbol(name: string, root = projectRoot()): Container | null {
  return loadLibraryProject(root) ? null : imageContainerFor(name, root);
}

/** Container kind for a symbol; `exe` whenever the name does not say otherwise. */
export function containerKindForSymbol(name: string, root = projectRoot()): "exe" | "overlay" {
  return containerForSymbol(name, root)?.kind ?? "exe";
}

/** The directory a symbol's translation unit belongs in. */
export function sourceDirFor(name: string, root = projectRoot()): string {
  return dirname(sourcePathFor(name, root));
}

/**
 * Where a function's C source belongs, whether or not it exists yet.
 *
 * `resolveSource` is the same answer for a file that must exist; this is for
 * the callers that have to decide whether it exists at all — a stub check, an
 * m2c first pass, a policy sweep.
 */
export function sourcePathFor(name: string, root = projectRoot()): string {
  return join(root, resolveFunctionTarget(name, root).source);
}

export function configuredMaspsxFlags(container?: FlagContext): string[] {
  return configuredFlags("maspsx", container);
}

export const CC1_FLAGS = liveFlags(configuredCc1Flags);

export const AS_FLAGS = liveFlags(configuredAsFlags);

export interface CompileArtifacts {
  source: string;
  /** For an assembly TU (`form: "assembly"`) this and `assembly` are the
   * hand-written `.s` source: nothing is preprocessed or compiled. */
  preprocessed: string;
  assembly: string;
  object?: string;
  form?: "c" | "assembly";
  outputDir: string;
  /** Full production assembly when assembly is a function-local diagnostic view. */
  translationUnitAssembly?: string;
  stem: string;
  cc1Flags: string[];
  /**
   * Everything the front end said while succeeding.
   *
   * A zero exit status is not a statement that the source is valid C: GCC 2.95
   * diagnoses a constraint violation such as `return` with a value in a
   * function returning `void`, then compiles it anyway. Discarding this stream
   * is how a candidate that violates C89 reaches the byte oracle, matches, and
   * is reported as a recovered seed — the oracle compares machine words and
   * cannot see the source defect. Callers that accept generated C must read it.
   */
  diagnostics: string;
}

function commandError(tool: string, error: any): Error {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString() : error?.stderr;
  const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString() : error?.stdout;
  const detail = String(stderr || stdout || error?.message || error).trim();
  return new Error(`${tool} failed${detail ? `: ${detail}` : ""}`);
}

export function runTool(command: string, args: string[], cwd: string = projectRoot()): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error: any) {
    throw commandError(command, error);
  }
}

/**
 * `runTool`, keeping what the tool said on the way to succeeding.
 *
 * `runTool` throws on failure and returns stdout on success, which silently
 * drops the one stream a compiler uses to report that it accepted something it
 * should not have.
 */
export function runToolCapturing(
  command: string,
  args: string[],
  cwd: string = projectRoot(),
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw commandError(command, { message: result.error.message });
  if (result.status !== 0) throw commandError(command, result);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runToolAsync(
  command: string,
  args: string[],
  cwd: string = projectRoot(),
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => reject(commandError(command, { message: error.message, stderr: Buffer.concat(stderr) })));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else reject(commandError(command, { message: `exit ${code}`, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
  });
}

/** `runToolAsync`, returning what the tool said rather than what it wrote. */
export function runToolAsyncCapturingStderr(
  command: string,
  args: string[],
  cwd: string = projectRoot(),
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => reject(commandError(command, { message: error.message, stderr: Buffer.concat(stderr) })));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stderr).toString("utf8"));
      else reject(commandError(command, { message: `exit ${code}`, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
  });
}

function firstVersionLine(command: string, args: string[]): string {
  try {
    return runTool(command, args).split("\n").find((line) => line.trim())?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function configuredToolchainIdentity(context?: FlagContext | string) {
  const flags = typeof context === "string" ? resolveFunctionTarget(context).flags : context;
  const selection = assemblerIdentity(flags);
  const maspsx = "maspsx" in selection ? { path: relativePath(selection.maspsx.path), sha256: selection.maspsx.sha256 } : undefined;
  const executables = toolchainExecutables(projectRoot(), selection.kind === "gas" ? ["maspsx"] : []);
  const cc = executables.cc1!;
  if (!cc.path || !cc.sha256) throw new Error(`Configured compiler not found: ${cc.command}. Run npm run setup and provision the toolchain.`);
  let cppFrontend: { path: string; sha256: string } | null = null;
  if (loadToolchain().compiler.family === "gcc") {
    const path = executablePath(runTool(configuredTool("cpp"), ["-print-prog-name=cc1"]).trim());
    if (path) cppFrontend = { path: relativePath(path), sha256: fileSha256(path) };
  }
  return {
    node: process.version,
    configSha256: toolchainDigest(),
    configuration: loadToolchain(),
    executables,
    cppFrontend,
    compiler: { path: relativePath(cc.path), sha256: cc.sha256, version: firstVersionLine(cc.command, ["--version"]) },
    ...(configuredAssemblerConfig(flags) ? {
      assembler: { kind: selection.kind, inputRewrites: selection.inputRewrites,
        ...(maspsx ? { maspsx } : {}) },
      cpp: firstVersionLine(configuredTool("cpp"), ["--version"]),
      assemblerVersion: firstVersionLine(executables.as!.command, ["--version"]),
    } : { assemblerShim: maspsx!,
      cpp: firstVersionLine(configuredTool("cpp"), ["--version"]),
      assembler: firstVersionLine(executables.as!.command, ["--version"]) }),
    objdump: firstVersionLine(configuredTool("objdump"), ["--version"]),
  };
}

function relativePath(path: string): string {
  return path.startsWith(`${projectRoot()}/`) ? path.slice(projectRoot().length + 1) : path;
}

export function normalizeFunctionName(value: string): string {
  return resolveFunctionTarget(value).key;
}

export function resolveSource(funcName: string, requested?: string): string {
  const source = requested || resolveFunctionTarget(funcName).source;
  const absolute = isAbsolute(source) ? source : join(projectRoot(), source);
  if (!existsSync(absolute)) throw new Error(`Source file not found: ${source}`);
  return absolute;
}

/**
 * A compiler diagnostic, split into the two kinds that matter to a generator.
 *
 * `rejecting` means the source violates a C89 constraint or converts between
 * incompatible types without saying so. GCC 2.95 diagnoses these and then
 * compiles the program anyway, so exit status cannot be the acceptance test
 * for generated C: a candidate that returns a value from a function declared
 * `void` assembles to exactly the same words as the valid spelling, matches the
 * byte oracle, and would be filed as recovered source that no one can compile
 * cleanly.
 *
 * `advisory` means the code is valid and the compiler is remarking on it — a
 * comparison that is always true, a constant that is unsigned. Those are
 * reported but never block a candidate, because a target genuinely can contain
 * the code that provokes them.
 */
export interface CompilerDiagnostic {
  severity: "rejecting" | "advisory";
  /** The diagnostic text, from `warning:`/`error:` onward. */
  message: string;
  /** The whole line, including the file and line number the compiler named. */
  line: string;
}

/**
 * Diagnostics that mean the generated C is wrong, not merely remarkable.
 *
 * Kept as an explicit list rather than "anything that is not on an allow list":
 * an unrecognised diagnostic should surface for a human to classify, not
 * silently condemn every candidate in a census.
 */
const REJECTING_DIAGNOSTICS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /with a value, in function returning void/, why: "C89 constraint: a void function cannot return a value" },
  { pattern: /with no value, in function returning non-void/, why: "C89: a valued function's `return` must carry a value" },
  { pattern: /makes pointer from integer without a cast/, why: "an implicit integer-to-pointer conversion" },
  { pattern: /makes integer from pointer without a cast/, why: "an implicit pointer-to-integer conversion" },
  { pattern: /from incompatible pointer type/, why: "incompatible pointer types" },
  { pattern: /incompatible types in/, why: "incompatible types" },
  { pattern: /conflicting types for/, why: "a declaration that conflicts with another in scope" },
  { pattern: /implicit declaration of function/, why: "an undeclared callee, which is implicit int and changes codegen" },
  { pattern: /parameter names \(without types\)/, why: "a parameter list without types" },
];

/** Split a front-end stderr stream into classified diagnostics. */
export function classifyDiagnostics(stderr: string): CompilerDiagnostic[] {
  const out: CompilerDiagnostic[] = [];
  for (const line of stderr.split("\n")) {
    const marker = line.search(/\b(?:warning|error):/);
    if (marker < 0) continue;
    const message = line.slice(marker);
    const rejecting = REJECTING_DIAGNOSTICS.some((entry) => entry.pattern.test(message));
    out.push({ severity: rejecting ? "rejecting" : "advisory", message, line });
  }
  return out;
}

/**
 * One line naming why a compile's output is not acceptable source, or null when
 * every diagnostic it produced was advisory.
 */
export function rejectionFromDiagnostics(stderr: string): string | null {
  const rejecting = classifyDiagnostics(stderr).filter((entry) => entry.severity === "rejecting");
  if (rejecting.length === 0) return null;
  const first = rejecting[0]!.message.replace(/^(?:warning|error):\s*/, "");
  const rest = rejecting.length > 1 ? ` (+${rejecting.length - 1} more)` : "";
  return `${first}${rest}`;
}

export function loadFlagOverrides(root = projectRoot()): Map<string, string[]> {
  return readFlagOverrides(root);
}

export function assembleCompilerOutput(
  assembly: string,
  object: string,
  kind: FlagContext["kind"] = "exe",
  containerId?: string,
): string {
  const origin = compilerAssemblyOrigin(assembly);
  const context = origin?.context ?? compilationContext(containerId ?? "", kind, containerId);
  assemble(context, origin?.assembly ?? assembly, object);
  if (origin) writeObjectFunctionView(object, origin.symbol);
  return object;
}

/** Kind-aware capture of the configured production assembler. */
export function captureAssemblerExpansion(assembly: string, object: string, symbol: string) {
  const origin = compilerAssemblyOrigin(assembly);
  return captureExpansion(origin?.context ?? compilationContext(symbol), origin?.assembly ?? assembly, object, symbol);
}

export function parseImplicitDeclarationWarnings(stderr: string): string[] {
  const callees = new Set<string>();
  for (const line of stderr.split("\n")) {
    const warning = line.match(/warning: implicit declaration of function [`'](.+)'/);
    if (warning) callees.add(warning[1]);
  }
  return [...callees];
}

/**
 * A call to an undeclared function is C89 implicit int, so the call defines
 * `$v0` even though nothing reads it — a TU-context fact that reshapes
 * register allocation from outside the function body. The front end is the
 * authority on which calls lack a declaration, so ask it: re-run cc1 on the
 * already-preprocessed unit with -Wimplicit and read the warnings.
 */
export function detectImplicitDeclarations(preprocessed: string, stem: string): string[] {
  requireCompilerCapability("gcc-implicit-declarations");
  const context = compilationContext(stem);
  const flags = [
    ...configuredFlags("cc1", context),
    ...(loadFlagOverrides().get(overrideKey(stem, context)) || []),
    ...(configuredCompilerAnalysis().profile?.capture.implicitFlags ?? ["-Wimplicit"]),
  ];
  const result = spawnSync(configuredTool("cc1"), [...flags, preprocessed, "-o", "/dev/null"], {
    cwd: projectRoot(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseImplicitDeclarationWarnings(result.stderr ?? "");
}

/**
 * Every file the preprocessor would read for this source: the source itself
 * plus its transitive includes, resolved by the preprocessor's own `-MM` pass
 * under the configured include paths — a scan of headers on disk answers a
 * different question. `-MG` keeps a not-yet-generated header in the list as a
 * name, so its later appearance still counts as an input change.
 *
 * This exists for cache keys: an artifact derived from a compile is stale when
 * any header it read changed, and a dependency list that omits headers is a
 * staleness hole (the Phase A1 failure in plans/automatic-matching-reconstruction.md).
 */
export function sourceDependencyFiles(source: string, context?: FlagContext, root = projectRoot()): string[] {
  const absoluteSource = isAbsolute(source) ? source : join(root, source);
  const flags = context ?? sourceFlagContext(absoluteSource, root);
  const member = flags?.kind === "library" ? libraryMemberById(flags.id!, root) : undefined;
  const assemblyTu = member ? libraryAssemblyTu(member, root) : undefined;
  if (member && assemblyTu) return [...new Set([absoluteSource, resolve(root, member.source), ...libraryAssemblyDependencies(assemblyTu, flags!, root)])];
  const input = member && isDirectoryTu(member) ? libraryDependencyInput(member, root) : absoluteSource;
  const output = runTool(configuredTool("cpp", root), [...configuredFlags("cpp", flags, root), "-MM", "-MG", input], root);
  const files: string[] = [];
  const text = output.replace(/\\\n/g, " ");
  const colon = text.indexOf(":");
  if (colon < 0) return [absoluteSource];
  for (const token of text.slice(colon + 1).trim().split(/\s+/)) {
    if (!token) continue;
    files.push(isAbsolute(token) ? token : join(root, token));
  }
  if (!files.includes(absoluteSource)) files.unshift(absoluteSource);
  return member && isDirectoryTu(member) ? [...new Set([...librarySourceFiles(member, root).map(p => resolve(root, p)), ...files.filter(p => p !== input)])] : files;
}

/**
 * Run only the preprocessor, and return the path to the `.i`.
 *
 * The preprocessed text is the exact set of declarations the compiler saw, so
 * it is the only sound answer to "what prototype is in scope here" — a scan of
 * the headers on disk answers a different question, because it counts
 * declarations this translation unit never includes.
 *
 * This shares `CPP` and `CPP_FLAGS` with `compileSource` on purpose: a second
 * spelling of the preprocessor invocation is a second thing to keep in step
 * with the project configuration, and it would drift silently.
 */
export function preprocessOnly(source: string, outputDir: string, stem: string, context?: FlagContext): string {
  const absoluteSource = isAbsolute(source) ? source : join(projectRoot(), source);
  const absoluteOutput = isAbsolute(outputDir) ? outputDir : join(projectRoot(), outputDir);
  mkdirSync(absoluteOutput, { recursive: true });
  const preprocessed = join(absoluteOutput, `${stem}.i`);
  const flags = context ?? sourceFlagContext(absoluteSource) ?? compilationContext(stem);
  const input = productionCompileInput(absoluteSource, absoluteOutput, flags, stem);
  runTool(configuredTool("cpp"), [...configuredFlags("cpp", flags), input, "-o", preprocessed]);
  return preprocessed;
}

/**
 * `-dp` annotates the first assembly line of each RTL instruction with its
 * UID, pattern name and declared length, which is the only sound way to learn
 * where one RTL instruction emitted several machine instructions. It is
 * opt-in: it appends text to instruction lines, and the production build in
 * the Makefile must stay byte-for-byte what it was.
 */
export function compileSource(
  source: string,
  outputDir: string,
  stem: string,
  options: {
    dumps?: boolean;
    assemble?: boolean;
    useOverrides?: boolean;
    extraCc1Flags?: string[];
    emissionAttribution?: boolean;
    /** Exact target-cpp output already verified by the caller's input bundle. */
    preprocessedText?: string;
    /**
     * Which container's flag set to compile under. Derived from `stem` when
     * omitted, which is what keeps every existing call site correct without
     * knowing containers exist. Pass it only when the stem is not the
     * function's own name.
     */
    containerKind?: FlagContext["kind"];
    containerId?: string;
  } = {},
): CompileArtifacts {
  const absoluteSource = isAbsolute(source) ? source : join(projectRoot(), source);
  const absoluteOutput = isAbsolute(outputDir) ? outputDir : join(projectRoot(), outputDir);
  mkdirSync(absoluteOutput, { recursive: true });

  const preprocessed = join(absoluteOutput, `${stem}.i`);
  const assembly = join(absoluteOutput, `${stem}.s`);
  const object = join(absoluteOutput, `${stem}.c.o`);

  const context = compilationContext(stem, options.containerKind, options.containerId);
  const assemblyTu = assemblyTranslationUnit(context);
  if (assemblyTu) {
    const planned = planAssemblyTranslationUnit(context, assemblyTu, absoluteSource, absoluteOutput, stem);
    if (options.assemble) assemble(context, assemblyTu.source, planned.object!);
    return planned;
  }
  resetCompilerArtifacts(absoluteOutput, stem);
  if (options.preprocessedText !== undefined) writeFileSync(preprocessed, options.preprocessedText);
  else runTool(configuredTool("cpp"), [...configuredFlags("cpp", context), productionCompileInput(absoluteSource, absoluteOutput, context, stem), "-o", preprocessed]);

  const overrides = options.useOverrides === false
    ? []
    : (loadFlagOverrides().get(overrideKey(stem, context)) || []);
  const cc1Flags = [...configuredFlags("cc1", context), ...overrides, ...(options.extraCc1Flags || [])];
  if (options.dumps) { requireCompilerCapability("gcc-rtl-dumps"); cc1Flags.push(...(configuredCompilerAnalysis().profile?.capture.dumpFlags ?? ["-da"])); }
  if (options.emissionAttribution) { requireCompilerCapability("gcc-emission-attribution"); cc1Flags.push(...(configuredCompilerAnalysis().profile?.capture.emissionFlags ?? ["-dp"])); }

  /* Running cc1 in the artifact directory keeps all -da files together. */
  const front = runToolCapturing(configuredTool("cc1"), [...cc1Flags, basename(preprocessed), "-o", basename(assembly)], absoluteOutput);

  if (options.assemble) assembleCompilerOutput(assembly, object, context.kind, context.id);

  const result: CompileArtifacts = {
    source: absoluteSource,
    preprocessed,
    assembly,
    outputDir: absoluteOutput,
    stem,
    cc1Flags,
    diagnostics: front.stderr,
  };
  if (options.assemble) result.object = object;
  projectDiagnosticArtifacts(result, context);
  return result;
}

/** A library member reconstructed as its one hand-written `.s`: the production
 * assembler (with its input rewrites) is the whole pipeline. */
function assemblyTranslationUnit(context: FlagContext): LibraryAssemblyTu | undefined {
  return context.kind === "library" && context.id ? libraryAssemblyTu(libraryMemberById(context.id), projectRoot()) : undefined;
}
function planAssemblyTranslationUnit(context: FlagContext, tu: LibraryAssemblyTu, source: string, outputDir: string, stem: string): CompileArtifacts {
  const member = libraryMemberById(context.id!);
  if (![resolve(projectRoot(), member.source), tu.source].includes(resolve(source)))
    throw new Error(`${member.id} is an assembly translation unit (${tu.part.path}); C candidates do not apply to it`);
  resetCompilerArtifacts(outputDir, stem);
  return { source, preprocessed: tu.source, assembly: tu.source, object: join(outputDir, `${stem}.c.o`), outputDir, stem, cc1Flags: [], diagnostics: "", form: "assembly" };
}
/** Production compile stays whole-TU; only diagnostic consumers see projections. */
function projectDiagnosticArtifacts(artifacts: CompileArtifacts, context: FlagContext): void {
  if (artifacts.form === "assembly") return; // no compiler output to project
  let symbol: string;
  try { symbol = resolveFunctionTarget(artifacts.stem).symbol; } catch { return; } // owner build, not a function diagnostic
  const compiledBody = new RegExp(`^\\s*\\.ent\\s+${symbol}(?:\\s|$)`, "m").test(readFileSync(artifacts.assembly, "utf8"));
  if (artifacts.object && (compiledBody || context.kind === "library")) writeObjectFunctionView(artifacts.object, symbol);
  if (!compiledBody) return; // selected stub or helper whose artifact stem is not a C symbol
  artifacts.translationUnitAssembly = projectCompilerArtifacts(artifacts.outputDir, artifacts.stem, symbol, context);
}

export async function compileSourceAsync(
  source: string,
  outputDir: string,
  stem: string,
  options: {
    dumps?: boolean;
    assemble?: boolean;
    useOverrides?: boolean;
    signal?: AbortSignal;
    containerKind?: FlagContext["kind"];
    containerId?: string;
  } = {},
): Promise<CompileArtifacts> {
  const absoluteSource = isAbsolute(source) ? source : join(projectRoot(), source);
  const absoluteOutput = isAbsolute(outputDir) ? outputDir : join(projectRoot(), outputDir);
  mkdirSync(absoluteOutput, { recursive: true });
  const preprocessed = join(absoluteOutput, `${stem}.i`);
  const assembly = join(absoluteOutput, `${stem}.s`);
  const object = join(absoluteOutput, `${stem}.c.o`);
  const context = compilationContext(stem, options.containerKind, options.containerId);
  const assemblyTu = assemblyTranslationUnit(context);
  if (assemblyTu) {
    const planned = planAssemblyTranslationUnit(context, assemblyTu, absoluteSource, absoluteOutput, stem);
    if (options.assemble) await assembleAsync(context, assemblyTu.source, planned.object!, projectRoot(), options.signal);
    return planned;
  }
  resetCompilerArtifacts(absoluteOutput, stem);
  await runToolAsync(configuredTool("cpp"), [...configuredFlags("cpp", context), productionCompileInput(absoluteSource, absoluteOutput, context, stem), "-o", preprocessed], projectRoot(), options.signal);
  const overrides = options.useOverrides === false ? [] : (loadFlagOverrides().get(overrideKey(stem, context)) || []);
  const cc1Flags = [...configuredFlags("cc1", context), ...overrides];
  if (options.dumps) { requireCompilerCapability("gcc-rtl-dumps"); cc1Flags.push(...(configuredCompilerAnalysis().profile?.capture.dumpFlags ?? ["-da"])); }
  const diagnostics = await runToolAsyncCapturingStderr(
    configuredTool("cc1"), [...cc1Flags, basename(preprocessed), "-o", basename(assembly)], absoluteOutput, options.signal);
  if (options.assemble) {
    await assembleAsync(context, assembly, object, projectRoot(), options.signal);
  }
  const result: CompileArtifacts = {
    source: absoluteSource, preprocessed, assembly, outputDir: absoluteOutput, stem, cc1Flags, diagnostics,
  };
  if (options.assemble) result.object = object;
  projectDiagnosticArtifacts(result, context);
  return result;
}

export function resolveAsmSource(funcName: string, root = projectRoot()): string | null {
  const path = join(root, resolveFunctionTarget(funcName, root).assembly.function);
  return existsSync(path) ? path : null;
}

export function assembleTarget(funcName: string, outputDir: string): string {
  if (loadLibraryProject()) {
    const { member, fn, key } = requireLibraryFunction(funcName);
    const directory = resolve(projectRoot(), outputDir); mkdirSync(directory, { recursive: true });
    const object = join(directory, `${key}.target.o`);
    const temporary = `${object}.${process.pid}.${assembleTargetSequence++}`;
    writeFileSync(temporary, member.bytes); renameSync(temporary, object);
    writeObjectFunctionView(object, fn.name);
    return object;
  }
  const asmSource = resolveAsmSource(funcName);
  if (!asmSource) {
    const container = containerForSymbol(funcName);
    const where = container ? containerPathHint(container) : "build/functions";
    throw new Error(`Original assembly not found for ${funcName}; run npm run disassemble to populate ${where}`);
  }
  /* The small-data threshold is a per-container fact, and it reaches the
     assembler as well as the compiler. Assembling an overlay's target under the
     executable's `-G8` puts its own reference bytes in a different section from
     the candidate's, so the comparison would be against the wrong target. */
  const owner = containerForSymbol(funcName);

  const absoluteOutput = isAbsolute(outputDir) ? outputDir : join(projectRoot(), outputDir);
  mkdirSync(absoluteOutput, { recursive: true });
  const wrapper = join(absoluteOutput, `${funcName}.target.s`);
  const object = join(absoluteOutput, `${funcName}.target.o`);
  const relativeAsm = asmSource.slice(projectRoot().length + 1);

  /*
   * Built under private names and moved into place, because these paths are
   * shared. A census runs several worker processes over one scratch directory,
   * and two of them resolving the same callee both write `<callee>.target.s`
   * and `<callee>.target.o`: one assembles a file the other is mid-write, and
   * the witness that comes back describes nothing. The result is a signature
   * that depends on what else happened to be running — the same function
   * resolving one way in a census and another on a retry, which is the shape
   * of every non-reproducible measurement. A rename is atomic on one
   * filesystem, so a concurrent reader sees the previous complete object or
   * this one, never a partial file, and both hold the same bytes.
   */
  const privateSuffix = `${process.pid}.${assembleTargetSequence++}`;
  const stagedWrapper = `${wrapper}.${privateSuffix}`;
  const stagedObject = `${object}.${privateSuffix}`;

  writeFileSync(stagedWrapper,
    `.include "include/macro.inc"\n` +
    `.set noat\n` +
    `.set noreorder\n` +
    `.include "${relativeAsm}"\n`,
  );

  try {
    assemble(owner ?? { kind: "exe", id: "exe" }, stagedWrapper, stagedObject, projectRoot(), { handwritten: true });
    renameSync(stagedObject, object);
    renameSync(stagedWrapper, wrapper);
  } catch (error) {
    for (const staged of [stagedObject, stagedWrapper]) {
      try { if (existsSync(staged)) rmSync(staged); } catch { /* best effort */ }
    }
    throw error;
  }
  return object;
}

/** Distinguishes concurrent assemblies inside one process as well as across them. */
let assembleTargetSequence = 0;

/** Where a container's disassembly archive lives, for an error message. */
function containerPathHint(container: Container): string {
  return `${container.paths.disasmDir}/functions`;
}

export interface DisassembledInstruction {
  address: number;
  mnemonic: string;
  operands: string[];
  operandText: string;
  relocation?: { type: string; symbol: string };
  raw: string;
}

/** Split operands without splitting the offset(base) syntax. */
export function splitOperands(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

export function disassembleObject(object: string, span?: { section: string; offset: number; size: number }): DisassembledInstruction[] {
  const symbol = objectFunctionView(object);
  if (!span && symbol) {
    span = objectFunctions(readRelocatableObject(readFileSync(object))).find(fn => fn.name === symbol);
    if (!span) throw new Error(`Object does not define ${symbol}: ${object}`);
  }
  const dump = runTool(configuredTool("objdump"), ["-dr", "--no-show-raw-insn", ...(span ? ["-j", span.section,
    `--start-address=${span.offset}`, `--stop-address=${span.offset + span.size}`] : []), object]);
  const instructions: DisassembledInstruction[] = [];
  const byAddress = new Map<number, DisassembledInstruction>();

  for (const line of dump.split("\n")) {
    const relocation = line.match(/^\s*([0-9a-f]+):\s+(R_MIPS_\S+)\s+(.+?)\s*$/i);
    if (relocation) {
      const instruction = byAddress.get(parseInt(relocation[1], 16));
      if (instruction) {
        instruction.relocation = { type: relocation[2], symbol: relocation[3].trim() };
      }
      continue;
    }

    const match = line.match(/^\s*([0-9a-f]+):\s+([a-z][a-z0-9_.]*)\s*(.*?)\s*$/i);
    if (!match) continue;
    const address = parseInt(match[1], 16);
    const instruction: DisassembledInstruction = {
      address,
      mnemonic: match[2].toLowerCase(),
      operands: splitOperands(match[3]),
      operandText: match[3],
      raw: line.trim(),
    };
    instructions.push(instruction);
    byAddress.set(address, instruction);
  }
  return instructions;
}

/** Function-local diagnostic view; acceptance still uses the target's full scope. */
export function disassembleFunctionObject(object: string, name: string): DisassembledInstruction[] {
  const target = requireTargetCapability(name, "functionInstructionView");
  if (target.coordinate.kind === "image") return disassembleObject(object);
  const fn = objectFunctions(readRelocatableObject(readFileSync(object))).find(f => f.name === target.symbol);
  if (!fn) throw new Error(`Object does not define ${target.symbol}: ${object}`);
  return disassembleObject(object, fn);
}
