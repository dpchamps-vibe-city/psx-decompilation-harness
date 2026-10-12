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
import { contextForProject, projectRoot, resolveOwnedPath, type OwnedPath, type RuntimeContext } from "./runtimeContext.js";
export { HARNESS_ROOT } from "./runtimeContext.js";

export const TOOLCHAIN_FILE = "toolchain.json";
export const TOOL_NAMES = ["cc1", "cpp", "as", "ld", "objcopy", "objdump", "nm", "readelf", "python", "splat", "spimdisasm", "maspsx", "m2c"] as const;
export type ToolName = typeof TOOL_NAMES[number] | "psyq2elf";
export const FLAG_NAMES = ["cpp", "cc1", "as", "ld", "maspsx", "m2c", "spimdisasm"] as const;
export type FlagName = typeof FLAG_NAMES[number];
export type ConfiguredPath = string | OwnedPath;
export interface ToolchainConfig {
  $schema?: string;
  schemaVersion: 1;
  compiler: { family: string; version: string; source?: ConfiguredPath; capabilities: string[] };
  tools: Record<typeof TOOL_NAMES[number], ConfiguredPath> & { psyq2elf?: ConfiguredPath };
  includeDirs: string[];
  flags: Record<FlagName, string[]>;
  /** A profile replaces the named flag arrays; omitted arrays inherit base. */
  profiles: Record<string, Partial<Record<FlagName, string[]>> & { includeDirs?: string[] }>;
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
export function loadToolchain(root = projectRoot()): ToolchainConfig {
  let value: any;
  try { value = JSON.parse(readFileSync(join(root, TOOLCHAIN_FILE), "utf8")); }
  catch (error) { throw new Error(`Cannot load ${join(root, TOOLCHAIN_FILE)}: ${String(error)}`); }
  object(value, "config");
  if (Object.hasOwn(value, "fileFlags")) throw new Error(`${TOOLCHAIN_FILE}: fileFlags is unsupported; use configs/flag_overrides.mk`);
  keys(value, ["$schema", "schemaVersion", "compiler", "tools", "includeDirs", "flags", "profiles", "containerProfiles", "sdk"], "config");
  if (value.schemaVersion !== 1) throw new Error(`${TOOLCHAIN_FILE}: unsupported schemaVersion ${value.schemaVersion}`);
  object(value.compiler, "compiler"); keys(value.compiler, ["family", "version", "source", "capabilities"], "compiler");
  string(value.compiler.family, "compiler.family"); string(value.compiler.version, "compiler.version");
  if (value.compiler.source !== undefined) ownedPath(value.compiler.source, "compiler.source", root);
  strings(value.compiler.capabilities, "compiler.capabilities");
  object(value.tools, "tools"); keys(value.tools, [...TOOL_NAMES, "psyq2elf"], "tools");
  for (const name of TOOL_NAMES) ownedPath(value.tools[name], `tools.${name}`, root);
  if (value.tools.psyq2elf !== undefined) ownedPath(value.tools.psyq2elf, "tools.psyq2elf", root);
  strings(value.includeDirs, "includeDirs");
  object(value.flags, "flags"); keys(value.flags, FLAG_NAMES, "flags");
  for (const name of FLAG_NAMES) strings(value.flags[name], `flags.${name}`);
  object(value.profiles, "profiles");
  for (const [name, profile] of Object.entries(value.profiles)) {
    const p = object(profile, `profiles.${name}`); keys(p, [...FLAG_NAMES, "includeDirs"], `profiles.${name}`);
    for (const [flag, args] of Object.entries(p)) strings(args, `profiles.${name}.${flag}`);
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
export function configuredTool(name: ToolName, root = projectRoot()): string {
  const value = loadToolchain(root).tools[name];
  if (!value) throw new Error(`${TOOLCHAIN_FILE}: tools.${name} is not configured`);
  if (typeof value === "object") {
    const context = contextForProject(root);
    return preparePinnedPath(value, resolveOwnedPath(value, context), context);
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
export function configuredFlags(name: FlagName, container?: FlagContext, root = projectRoot()): string[] {
  const config = loadToolchain(root);
  const profile = container ? container.profile ?? config.containerProfiles[container.id ?? ""] ?? config.containerProfiles[container.kind] : undefined;
  if (profile && !config.profiles[profile]) throw new Error(`${TOOLCHAIN_FILE}: unknown profile ${profile}`);
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
export function requireCompilerCapability(capability: string, root = projectRoot()): void {
  const compiler = loadToolchain(root).compiler;
  if (!compiler.capabilities.includes(capability)) throw new Error(`${capability} is not supported by configured ${compiler.family} ${compiler.version}; use ordinary compilation/byte verification or configure a supported analysis toolchain`);
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
  return loadToolchain(root).compiler.family === "gcc"
    ? executablePath(execFileSync(cpp, ["-print-prog-name=cc1"], { cwd: root, encoding: "utf8" }).trim(), root)
    : cpp;
}
export function toolchainDigest(root = projectRoot()): string { return createHash("sha256").update(readFileSync(join(root, TOOLCHAIN_FILE))).digest("hex"); }
export function toolchainExecutables(root = projectRoot()): Record<string, { command: string; path: string | null; sha256: string | null }> {
  return Object.fromEntries(Object.keys(loadToolchain(root).tools).map(name => {
    const command = configuredTool(name as ToolName, root), path = executablePath(command, root);
    return [name, { command, path, sha256: path ? fileDigest(path) : null }];
  }));
}
