/** Configured argv and explicitly owned paths. Read on each request so edits
 * and same-process project switches cannot borrow another target's settings. */
import { createHash } from "node:crypto";
import { installedDependency } from "./installedScripts.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileDigest } from "./contentCache.js";
import { fileOverrideFlags } from "./flagOverrides.js";
import { prepareSupportedCompiler } from "../build/prepareCompiler.js";
import { resolveCompilerAnalysis, type CompilerAnalysisSelection } from "./compilerAnalysis.js";
import { contextForProject, projectRoot, resolveOwnedPath, type OwnedPath, type RuntimeContext } from "./runtimeContext.js";
export { HARNESS_ROOT } from "./runtimeContext.js";

export const TOOLCHAIN_FILE = "toolchain.json";
export const TOOL_NAMES = ["cc1", "cpp", "as", "ld", "objcopy", "objdump", "nm", "readelf", "python", "splat", "spimdisasm", "maspsx", "m2c"] as const;
export type ToolName = typeof TOOL_NAMES[number] | "psyq2elf";
export const FLAG_NAMES = ["cpp", "cc1", "as", "ld", "maspsx", "m2c", "spimdisasm"] as const;
export type FlagName = typeof FLAG_NAMES[number];
export type ConfiguredPath = string | OwnedPath;
export type AssemblerKind = "maspsx" | "gas";
export const ASSEMBLER_REWRITES = ["move-addu"] as const;
export type AssemblerConfig = { kind: "maspsx" } | { kind: "gas"; inputRewrites: string[] };
export interface AssemblerSelection { kind: AssemblerKind; inputRewrites: string[] }
export interface ToolchainConfig {
  assembler?: AssemblerConfig;
  $schema?: string;
  schemaVersion: 1;
  compiler: { family: string; version: string; source?: ConfiguredPath; capabilities?: string[]; analysis?: CompilerAnalysisSelection };
  tools: Record<typeof TOOL_NAMES[number], ConfiguredPath> & { psyq2elf?: ConfiguredPath };
  includeDirs: string[];
  flags: Record<FlagName, string[]>;
  /** A profile replaces the named flag arrays; omitted arrays inherit base. */
  profiles: Record<string, Partial<Record<FlagName, string[]>> & { includeDirs?: string[]; assembler?: AssemblerConfig }>;
  containerProfiles: Record<string, string>;
  sdk: { version: string; convertedDir: ConfiguredPath; originalDir: ConfiguredPath; signatures: ConfiguredPath; headers?: ConfiguredPath };
}
function object(value: unknown, at: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be an object`);
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${TOOLCHAIN_FILE}: unknown ${at}.${key}`);
}
function string(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be a non-empty string`);
}
function ownedPath(value: unknown, at: string, root: string): void {
  if (typeof value === "string") { string(value, at); return; }
  const path = object(value, at); keys(path, ["origin", "path"], at);
  string(path.origin, `${at}.origin`); string(path.path, `${at}.path`);
  resolveOwnedPath(path as OwnedPath, contextForProject(root));
}
function strings(value: unknown, at: string): void {
  if (!Array.isArray(value)) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be an array of arguments, not a shell command`);
  for (const item of value) string(item, at);
}
function validateAssembler(value: unknown, at: string): void {
  const selection = object(value, at);
  keys(selection, selection.kind === "gas" ? ["kind", "inputRewrites"] : ["kind"], at);
  if (!["maspsx", "gas"].includes(selection.kind)) throw new Error(`${TOOLCHAIN_FILE}: unknown ${at}.kind ${selection.kind}`);
  if (selection.kind === "gas") {
    strings(selection.inputRewrites, `${at}.inputRewrites`);
    for (const id of selection.inputRewrites) if (!ASSEMBLER_REWRITES.includes(id)) throw new Error(`${TOOLCHAIN_FILE}: unknown assembler input rewrite ${id}`);
    if (new Set(selection.inputRewrites).size !== selection.inputRewrites.length) throw new Error(`${TOOLCHAIN_FILE}: duplicate ${at}.inputRewrites`);
  }
}
/** GAS assumes undeclared externs are small; this rule is not yet modeled. */
export function assertAssemblerSmallData(selection: AssemblerSelection, flags: readonly string[]): void {
  if (selection.kind !== "gas") return;
  let threshold = 8; // GNU as default, unlike MASPSX's implicit -G0.
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "-G") threshold = Number(flags[++i]);
    else if (/^-G(?:=)?/.test(flag)) threshold = Number(flag.slice(2).replace(/^=/, ""));
    else if (flag.startsWith("--gpsize=")) threshold = Number(flag.slice(9));
    else if (flag === "--gpsize") threshold = Number(flags[++i]);
  }
  if (threshold !== 0) throw new Error(`${TOOLCHAIN_FILE}: gas requires explicit -G0 in flags.as; nonzero/default small-data rules are unsupported`);
}
/* Validation is a function of the file's text alone, so text already accepted
 * for a root is not validated again. The file is still read on every request,
 * and each caller gets its own parsed copy. */
const validatedToolchains = new Map<string, string>();
export function loadToolchain(root = projectRoot()): ToolchainConfig {
  let text: string;
  try { text = readFileSync(join(root, TOOLCHAIN_FILE), "utf8"); }
  catch (error) { throw new Error(`Cannot load ${join(root, TOOLCHAIN_FILE)}: ${String(error)}`); }
  const key = resolve(root);
  if (validatedToolchains.get(key) === text) return JSON.parse(text) as ToolchainConfig;
  const value = validateToolchain(text, root);
  validatedToolchains.set(key, text);
  return value;
}
function validateToolchain(text: string, root: string): ToolchainConfig {
  let value: any;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot load ${join(root, TOOLCHAIN_FILE)}: ${String(error)}`); }
  object(value, "config");
  if (Object.hasOwn(value, "fileFlags")) throw new Error(`${TOOLCHAIN_FILE}: fileFlags is unsupported; use configs/flag_overrides.mk`);
  keys(value, ["$schema", "schemaVersion", "compiler", "tools", "includeDirs", "flags", "profiles", "containerProfiles", "sdk", "assembler"], "config");
  if (value.assembler !== undefined) validateAssembler(value.assembler, "assembler");
  if (value.schemaVersion !== 1) throw new Error(`${TOOLCHAIN_FILE}: unsupported schemaVersion ${value.schemaVersion}`);
  object(value.compiler, "compiler"); keys(value.compiler, ["family", "version", "source", "capabilities", "analysis"], "compiler");
  string(value.compiler.family, "compiler.family"); string(value.compiler.version, "compiler.version");
  if (value.compiler.source !== undefined) ownedPath(value.compiler.source, "compiler.source", root);
  if (value.compiler.capabilities !== undefined) strings(value.compiler.capabilities, "compiler.capabilities");
  if (value.compiler.analysis !== undefined) {
    const analysis = object(value.compiler.analysis, "compiler.analysis");
    keys(analysis, ["provider", "profile"], "compiler.analysis");
    string(analysis.provider, "compiler.analysis.provider");
    ownedPath(analysis.profile, "compiler.analysis.profile", root);
  }
  object(value.tools, "tools"); keys(value.tools, [...TOOL_NAMES, "psyq2elf"], "tools");
  for (const name of TOOL_NAMES) ownedPath(value.tools[name], `tools.${name}`, root);
  if (value.tools.psyq2elf !== undefined) ownedPath(value.tools.psyq2elf, "tools.psyq2elf", root);
  strings(value.includeDirs, "includeDirs");
  object(value.flags, "flags"); keys(value.flags, FLAG_NAMES, "flags");
  for (const name of FLAG_NAMES) strings(value.flags[name], `flags.${name}`);
  object(value.profiles, "profiles");
  for (const [name, profile] of Object.entries(value.profiles)) {
    const p = object(profile, `profiles.${name}`); keys(p, [...FLAG_NAMES, "includeDirs", "assembler"], `profiles.${name}`);
    for (const [flag, args] of Object.entries(p)) {
      if (flag === "assembler") validateAssembler(args, `profiles.${name}.assembler`);
      else strings(args, `profiles.${name}.${flag}`);
    }
  }
  object(value.containerProfiles, "containerProfiles");
  for (const [id, name] of Object.entries(value.containerProfiles)) {
    string(name, `containerProfiles.${id}`);
    if (!Object.hasOwn(value.profiles, name)) throw new Error(`${TOOLCHAIN_FILE}: container ${id} selects unknown profile ${name}`);
  }
  object(value.sdk, "sdk"); keys(value.sdk, ["version", "convertedDir", "originalDir", "signatures", "headers"], "sdk");
  string(value.sdk.version, "sdk.version");
  for (const name of ["convertedDir", "originalDir", "signatures"]) ownedPath(value.sdk[name], `sdk.${name}`, root);
  if (value.sdk.headers !== undefined) ownedPath(value.sdk.headers, "sdk.headers", root);
  for (const profile of [undefined, ...Object.values(value.profiles)] as Array<any>) {
    const assembler = profile?.assembler ?? value.assembler ?? { kind: "maspsx" };
    assertAssemblerSmallData({ ...assembler, inputRewrites: assembler.inputRewrites ?? [] }, profile?.as ?? value.flags.as);
  }
  return value as ToolchainConfig;
}
function preparePinnedPath(value: ConfiguredPath, path: string, context: RuntimeContext): string {
  if (typeof value !== "object" || value.origin !== "runtime" || existsSync(path)) return path;
  if (value.path === "dependencies/compiler/gcc-2.95.2-psx/cc1") return prepareSupportedCompiler(context.projectRoot);
  const match = /^dependencies\/(m2c|maspsx|psx_psyq_signatures)\/([a-f0-9]{40})(?:\/|$)/.exec(value.path);
  if (!match) return path;
  const manifest = JSON.parse(readFileSync(join(context.harnessRoot, "templates/vendor-sources.json"), "utf8"));
  if (!manifest.sources.some((source: { name: string; revision: string }) => source.name === match[1] && source.revision === match[2])) throw new Error(`Unknown public dependency pin: ${value.path}`);
  execFileSync(process.execPath, ["--import", installedDependency("tsx", context.harnessRoot), join(context.harnessRoot, "tools/lib/scriptHost.ts"), join(context.harnessRoot, "tools/build/prepareDependencies.ts"), "--project", context.projectRoot], { cwd: context.projectRoot, stdio: "inherit" });
  if (!existsSync(path)) throw new Error(`Pinned dependency did not provide configured path: ${path}`);
  return path;
}
/** Bare configured commands use PATH; relative paths have exactly one owner. */
export function configuredTool(name: ToolName, root = projectRoot(), options: { prepare?: boolean } = {}): string {
  const value = loadToolchain(root).tools[name];
  if (!value) throw new Error(`${TOOLCHAIN_FILE}: tools.${name} is not configured`);
  if (typeof value === "object") {
    const context = contextForProject(root);
    const path = resolveOwnedPath(value, context);
    return options.prepare === false ? path : preparePinnedPath(value, path, context);
  }
  return value.includes("/") || isAbsolute(value) ? resolve(root, value) : value;
}
export function configuredCompilerSource(root = projectRoot()): string | undefined {
  const value = loadToolchain(root).compiler.source;
  if (value === undefined) return undefined;
  const source = resolveOwnedPath(value, contextForProject(root));
  if (!existsSync(source) && typeof value === "object" && value.origin === "runtime" &&
      value.path === "dependencies/compiler/gcc-2.95.2-psx/compiler-source") {
    /* The supported compiler build exports its own source. Existing binaries
     * lacking an export stay untouched and require explicit source provision. */
    configuredTool("cc1", root);
  }
  return source;
}
export interface FlagContext { id?: string | undefined; kind: "exe" | "overlay" | "library"; profile?: string }
function selectedProfile(config: ToolchainConfig, container?: FlagContext): string | undefined {
  const profile = container ? container.profile ?? config.containerProfiles[container.id ?? ""] ?? config.containerProfiles[container.kind] : undefined;
  if (profile && !config.profiles[profile]) throw new Error(`${TOOLCHAIN_FILE}: unknown profile ${profile}`);
  return profile;
}
/** The profile a context compiles under: its own, its container's, then its
 * kind's. Every flag and assembler selection for the context follows from it. */
export function configuredProfile(container?: FlagContext, root = projectRoot()): string | undefined {
  return selectedProfile(loadToolchain(root), container);
}
/** Same owner precedence as flags; a supplied assembler replaces the whole base. */
export function configuredAssemblerConfig(container?: FlagContext, root = projectRoot()): AssemblerConfig | undefined {
  const config = loadToolchain(root), profile = selectedProfile(config, container);
  return (profile ? config.profiles[profile]?.assembler : undefined) ?? config.assembler;
}
export function configuredAssembler(container?: FlagContext, root = projectRoot()): AssemblerSelection {
  const selection = configuredAssemblerConfig(container, root) ?? { kind: "maspsx" };
  return { kind: selection.kind, inputRewrites: selection.kind === "gas" ? [...selection.inputRewrites] : [] };
}
export function configuredFlags(name: FlagName, container?: FlagContext, root = projectRoot()): string[] {
  const config = loadToolchain(root), profile = selectedProfile(config, container);
  const selected = profile ? config.profiles[profile] : undefined;
  const flags = [...(selected?.[name] ?? config.flags[name])];
  if (name === "cpp" || name === "as") flags.unshift(...(selected?.includeDirs ?? config.includeDirs).map(p => `-I${resolve(root, p)}`));
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "-I" && flags[i + 1]) flags[++i] = resolve(root, flags[i]!);
    else if (flags[i]!.startsWith("-I") && flags[i]!.length > 2) flags[i] = `-I${resolve(root, flags[i]!.slice(2))}`;
  }
  return flags;
}
export function configuredFileFlags(stem: string, root = projectRoot()): string[] { return fileOverrideFlags(root, stem); }
export function configuredSdk(root = projectRoot()): { version: string; convertedDir: string; originalDir: string; signatures: string } {
  const sdk = loadToolchain(root).sdk, context = contextForProject(root);
  return { version: sdk.version, convertedDir: resolveOwnedPath(sdk.convertedDir, context), originalDir: resolveOwnedPath(sdk.originalDir, context), signatures: preparePinnedPath(sdk.signatures, resolveOwnedPath(sdk.signatures, context), context) };
}
export function configuredSdkHeaders(root = projectRoot()): string[] {
  const headers = loadToolchain(root).sdk.headers;
  return headers ? [resolveOwnedPath(headers, contextForProject(root))] : [];
}
/** Original SDKs often use DOS uppercase filenames. Resolve without renaming
 * inputs, borrowing package headers, or silently choosing a case collision. */
export function configuredSdkHeader(name: string, root = projectRoot()): string | undefined {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`SDK header must be a filename: ${name}`);
  const explicit = configuredSdkHeaders(root);
  const directories = explicit.length ? explicit : loadToolchain(root).includeDirs.map(dir => resolve(root, dir));
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    const matches = readdirSync(directory).filter(entry => entry.toLowerCase() === name.toLowerCase()
      && statSync(join(directory, entry)).isFile()).sort();
    if (matches.length > 1) throw new Error(`Ambiguous SDK header ${name} in ${directory}: ${matches.join(", ")}`);
    if (matches.length === 1) return join(directory, matches[0]!);
  }
  return undefined;
}
export function configuredCompilerAnalysis(root = projectRoot()) {
  const config = loadToolchain(root);
  return resolveCompilerAnalysis(config, config.compiler.analysis ? executablePath(configuredTool("cc1", root, { prepare: false }), root) : null, root);
}
export function supportsCompilerCapability(capability: string, root = projectRoot()): boolean {
  const support = configuredCompilerAnalysis(root);
  // Preserve explicitly declared legacy consumers; measured profiles grant each feature separately.
  if (!support.profile && support.provider === "legacy-declarations" &&
      ["gcc-pass-models", "gcc-pre-dbr-replay"].includes(capability)) return support.capabilities.includes("gcc-rtl-dumps");
  return support.capabilities.includes(capability);
}
export function requireCompilerCapability(capability: string, root = projectRoot()): void {
  const support = configuredCompilerAnalysis(root), compiler = loadToolchain(root).compiler;
  if (!supportsCompilerCapability(capability, root)) throw new Error(`${capability} is unavailable for configured ${compiler.family} ${compiler.version} (${support.provider}). ${support.reason ?? "The selected provider has not validated this feature."} Production compilation and byte verification remain available; do not substitute another compiler or pass model.`);
}
export function executablePath(command: string, root = projectRoot()): string | null {
  const candidates = command.includes("/") ? [resolve(root, command)] : (process.env.PATH ?? "").split(delimiter).map(p => resolve(root, p, command));
  return candidates.find(p => existsSync(p) && statSync(p).isFile()) ?? null;
}
/** GCC's configured preprocessor driver delegates to a separate cc1 binary.
 * Its bytes are an input even when the driver itself did not change. */
export function configuredCppFrontend(root = projectRoot()): string | null {
  const cpp = executablePath(configuredTool("cpp", root), root);
  if (!cpp) return null;
  return loadToolchain(root).compiler.family === "gcc" ? executablePath(cppFrontendName(cpp, root), root) : cpp;
}
/* Asking the driver costs a process per compile identity. Its answer depends on
 * the driver and the search environment, so it is re-asked whenever either
 * changes. A driver written in the last few seconds is always re-asked: a
 * rewrite inside one timestamp tick would otherwise leave its stat unchanged. */
const cppFrontendNames = new Map<string, { stamp: string; name: string }>();
function cppFrontendName(cpp: string, root: string): string {
  const stat = statSync(cpp, { bigint: true });
  const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  const key = [resolve(root), cpp, process.env.GCC_EXEC_PREFIX ?? "", process.env.COMPILER_PATH ?? "", process.env.PATH ?? ""].join("\0");
  const prior = cppFrontendNames.get(key);
  if (prior?.stamp === stamp) return prior.name;
  const name = execFileSync(cpp, ["-print-prog-name=cc1"], { cwd: root, encoding: "utf8" }).trim();
  if (Date.now() - Number(stat.ctimeMs) > 5_000) cppFrontendNames.set(key, { stamp, name });
  return name;
}
export function toolchainDigest(root = projectRoot()): string { return createHash("sha256").update(readFileSync(join(root, TOOLCHAIN_FILE))).digest("hex"); }
export function toolchainExecutables(root = projectRoot(), excluded: string[] = []): Record<string, { command: string; path: string | null; sha256: string | null }> {
  return Object.fromEntries(Object.keys(loadToolchain(root).tools).filter(name => !excluded.includes(name)).map(name => {
    const command = configuredTool(name as ToolName, root), path = executablePath(command, root);
    return [name, { command, path, sha256: path ? fileDigest(path) : null }];
  }));
}
