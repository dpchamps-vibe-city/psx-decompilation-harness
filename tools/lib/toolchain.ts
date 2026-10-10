/** Shared, root-relative toolchain configuration. No shell parsing, Makefile
 * inference, or guessed container flags. Read on every request so Pi sessions
 * and content caches see edits made while they are running. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TOOLCHAIN_FILE = "toolchain.json";
export const TOOL_NAMES = ["cc1", "cpp", "as", "ld", "objcopy", "objdump", "nm", "readelf", "python", "splat", "spimdisasm", "maspsx", "m2c"] as const;
export type ToolName = typeof TOOL_NAMES[number] | "psyq2elf";
export const FLAG_NAMES = ["cpp", "cc1", "as", "ld", "maspsx", "m2c", "spimdisasm"] as const;
export type FlagName = typeof FLAG_NAMES[number];
export interface ToolchainConfig {
  $schema?: string;
  schemaVersion: 1;
  compiler: { family: string; version: string; source?: string; capabilities: string[] };
  tools: Record<typeof TOOL_NAMES[number], string> & { psyq2elf?: string };
  includeDirs: string[];
  flags: Record<FlagName, string[]>;
  /** A profile replaces the named flag arrays; omitted arrays inherit base. */
  profiles: Record<string, Partial<Record<"cc1" | "as" | "ld" | "maspsx", string[]>>>;
  /** Exact container id first, then kind (exe/overlay). No implicit selection. */
  containerProfiles: Record<string, string>;
  /** Additional cc1 flags, keyed by source/function stem. */
  fileFlags: Record<string, string[]>;
  sdk: { version: string; convertedDir: string; originalDir: string; signatures: string };
}
function object(value: unknown, at: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be an object`);
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${TOOLCHAIN_FILE}: unknown ${at}.${key}`);
}
function string(value: unknown, at: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be a non-empty string`);
}
function strings(value: unknown, at: string): void {
  if (!Array.isArray(value)) throw new Error(`${TOOLCHAIN_FILE}: ${at} must be an array of arguments, not a shell command`);
  for (const item of value) string(item, at);
}
export function loadToolchain(root = HARNESS_ROOT): ToolchainConfig {
  let value: any;
  try { value = JSON.parse(readFileSync(join(root, TOOLCHAIN_FILE), "utf8")); }
  catch (error) { throw new Error(`Cannot load ${join(root, TOOLCHAIN_FILE)}: ${String(error)}`); }
  object(value, "config");
  keys(value, ["$schema", "schemaVersion", "compiler", "tools", "includeDirs", "flags", "profiles", "containerProfiles", "fileFlags", "sdk"], "config");
  if (value.schemaVersion !== 1) throw new Error(`${TOOLCHAIN_FILE}: unsupported schemaVersion ${value.schemaVersion}`);
  object(value.compiler, "compiler"); keys(value.compiler, ["family", "version", "source", "capabilities"], "compiler");
  string(value.compiler.family, "compiler.family"); string(value.compiler.version, "compiler.version");
  if (value.compiler.source !== undefined) string(value.compiler.source, "compiler.source");
  strings(value.compiler.capabilities, "compiler.capabilities");
  object(value.tools, "tools"); keys(value.tools, [...TOOL_NAMES, "psyq2elf"], "tools");
  for (const name of TOOL_NAMES) string(value.tools[name], `tools.${name}`);
  if (value.tools.psyq2elf !== undefined) string(value.tools.psyq2elf, "tools.psyq2elf");
  strings(value.includeDirs, "includeDirs");
  object(value.flags, "flags"); keys(value.flags, FLAG_NAMES, "flags");
  for (const name of FLAG_NAMES) strings(value.flags[name], `flags.${name}`);
  object(value.profiles, "profiles");
  for (const [name, profile] of Object.entries(value.profiles)) {
    const p = object(profile, `profiles.${name}`); keys(p, ["cc1", "as", "ld", "maspsx"], `profiles.${name}`);
    for (const [flag, args] of Object.entries(p)) strings(args, `profiles.${name}.${flag}`);
  }
  object(value.containerProfiles, "containerProfiles");
  for (const [id, name] of Object.entries(value.containerProfiles)) {
    string(name, `containerProfiles.${id}`);
    if (!Object.hasOwn(value.profiles, name as string)) throw new Error(`${TOOLCHAIN_FILE}: container ${id} selects unknown profile ${name}`);
  }
  object(value.fileFlags, "fileFlags");
  for (const [name, args] of Object.entries(value.fileFlags)) strings(args, `fileFlags.${name}`);
  object(value.sdk, "sdk"); keys(value.sdk, ["version", "convertedDir", "originalDir", "signatures"], "sdk");
  for (const name of ["version", "convertedDir", "originalDir", "signatures"]) string(value.sdk[name], `sdk.${name}`);
  return value as ToolchainConfig;
}
/** Paths containing '/' are anchored to the template root; bare names use PATH. */
export function configuredTool(name: ToolName, root = HARNESS_ROOT): string {
  const value = loadToolchain(root).tools[name];
  if (!value) throw new Error(`${TOOLCHAIN_FILE}: tools.${name} is not configured`);
  if (value.includes("/") || isAbsolute(value)) return resolve(root, value);
  if (name === "maspsx" || name === "m2c") return executablePath(value, root) ?? resolve(root, value);
  return value;
}
export function configuredFlags(name: FlagName, container?: { id?: string | undefined; kind: "exe" | "overlay" }, root = HARNESS_ROOT): string[] {
  const config = loadToolchain(root);
  const profile = container ? config.containerProfiles[container.id ?? ""] ?? config.containerProfiles[container.kind] : undefined;
  const flags = [...(profile ? (config.profiles[profile] as Partial<Record<FlagName, string[]>>)[name] ?? config.flags[name] : config.flags[name])];
  // Includes are shared between production and diagnostics. Preserve one argv
  // item per path, including paths with spaces; never join them into a shell.
  if (name === "cpp" || name === "as") flags.unshift(...config.includeDirs.map(p => `-I${resolve(root, p)}`));
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "-I" && flags[i + 1]) flags[++i] = resolve(root, flags[i]!);
    else if (flags[i]!.startsWith("-I") && flags[i]!.length > 2) flags[i] = `-I${resolve(root, flags[i]!.slice(2))}`;
  }
  return flags;
}
export function configuredFileFlags(stem: string, root = HARNESS_ROOT): string[] {
  return [...(loadToolchain(root).fileFlags[stem] ?? [])];
}
export function configuredSdk(root = HARNESS_ROOT): ToolchainConfig["sdk"] {
  const sdk = loadToolchain(root).sdk;
  return { ...sdk, convertedDir: resolve(root, sdk.convertedDir), originalDir: resolve(root, sdk.originalDir), signatures: resolve(root, sdk.signatures) };
}
export function requireCompilerCapability(capability: string, root = HARNESS_ROOT): void {
  const compiler = loadToolchain(root).compiler;
  if (!compiler.capabilities.includes(capability)) throw new Error(`${capability} is not supported by configured ${compiler.family} ${compiler.version}; use ordinary compilation/byte verification or configure a supported analysis toolchain`);
}
export function executablePath(command: string, root = HARNESS_ROOT): string | null {
  const candidates = command.includes("/") ? [resolve(root, command)] : (process.env.PATH ?? "").split(delimiter).map(p => resolve(root, p, command));
  return candidates.find(p => existsSync(p) && statSync(p).isFile()) ?? null;
}
export function toolchainDigest(root = HARNESS_ROOT): string {
  return createHash("sha256").update(readFileSync(join(root, TOOLCHAIN_FILE))).digest("hex");
}
export function toolchainExecutables(root = HARNESS_ROOT): Record<string, { command: string; path: string | null; sha256: string | null }> {
  return Object.fromEntries(Object.keys(loadToolchain(root).tools).map(name => {
    const command = configuredTool(name as ToolName, root), path = executablePath(command, root);
    return [name, { command, path, sha256: path ? createHash("sha256").update(readFileSync(path)).digest("hex") : null }];
  }));
}
