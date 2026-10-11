/** Ownership boundary for installed implementation, target inputs and outputs.
 * Invocation scopes carry an explicitly resolved context through asynchronous
 * internal calls. There is no cwd/environment/package-target fallback here. */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export interface SharedInput {
  /** Project-relative immutable input mount in this workspace. */
  path: string;
  /** Exact parent-project input location, not a general symlink exemption. */
  source: string;
}
export interface RuntimeContext {
  readonly harnessRoot: string;
  readonly projectRoot: string;
  readonly runtimeRoot: string;
  readonly parentProjectRoot?: string;
  readonly sharedInputs: readonly SharedInput[];
}
export type PathOrigin = "harness" | "project" | "runtime" | "external";
export interface OwnedPath { origin: PathOrigin; path: string }
const scopes = new AsyncLocalStorage<RuntimeContext>();

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function discoverProjectRoot(start: string): string {
  let root = resolve(start);
  while (true) {
    if (existsSync(resolve(root, "toolchain.json"))) return root;
    const parent = dirname(root);
    if (parent === root) throw new Error("No configured PSX project. Use /skill:psx-bootstrap-project first.");
    root = parent;
  }
}
export function createRuntimeContext(project: string, options: {
  harnessRoot?: string; runtimeRoot?: string; parentProjectRoot?: string; sharedInputs?: readonly SharedInput[];
} = {}): RuntimeContext {
  const projectRoot = discoverProjectRoot(project);
  const harnessRoot = resolve(options.harnessRoot ?? HARNESS_ROOT);
  const runtimeRoot = resolve(options.runtimeRoot ?? resolve(projectRoot, "build"));
  if (!inside(projectRoot, runtimeRoot)) throw new Error("Runtime outputs must be isolated inside the project/workspace");
  const declaration = resolve(runtimeRoot, "runtime-context.json");
  let recorded: { schemaVersion: number; projectRoot: string; parentProjectRoot?: string; sharedInputs?: SharedInput[] } | undefined;
  if (options.parentProjectRoot === undefined && existsSync(declaration)) {
    recorded = JSON.parse(readFileSync(declaration, "utf8"));
    if (recorded?.schemaVersion !== 1 || resolve(recorded.projectRoot) !== projectRoot) throw new Error("Invalid workspace runtime-context declaration");
  }
  const parent = options.parentProjectRoot ?? recorded?.parentProjectRoot;
  const parentProjectRoot = parent ? resolve(parent) : undefined;
  const sharedInputs = (options.sharedInputs ?? recorded?.sharedInputs ?? []).map(input => {
    if (!parentProjectRoot || isAbsolute(input.path) || input.path.split(/[\\/]/).includes("..")) throw new Error("Shared inputs require a parent project and safe workspace-relative mount");
    const source = resolve(input.source);
    if (!inside(parentProjectRoot, source)) throw new Error(`Shared input is not owned by the declared parent project: ${source}`);
    return Object.freeze({ path: input.path, source });
  });
  return Object.freeze({ projectRoot, harnessRoot, runtimeRoot, ...(parentProjectRoot ? { parentProjectRoot } : {}), sharedInputs: Object.freeze(sharedInputs) });
}
export function runtimeContext(): RuntimeContext {
  const context = scopes.getStore();
  if (!context) throw new Error("Missing explicit PSX runtime context; call the operation with its project context.");
  return context;
}
export function inRuntimeContext<T>(context: RuntimeContext, operation: () => T): T {
  return scopes.run(context, operation);
}
export function contextForProject(root: string): RuntimeContext {
  const current = scopes.getStore();
  return current?.projectRoot === resolve(root) ? current : createRuntimeContext(root);
}
export function projectRoot(): string { return runtimeContext().projectRoot; }
export function runtimeRoot(): string { return runtimeContext().runtimeRoot; }
export function harnessRoot(): string { return runtimeContext().harnessRoot; }
export function resolveOwnedPath(value: string | OwnedPath, context: RuntimeContext): string {
  if (typeof value === "string") return resolve(context.projectRoot, value);
  if (!value || !["harness", "project", "runtime", "external"].includes(value.origin) || typeof value.path !== "string" || !value.path || value.path.includes("\0")) throw new Error("Invalid owned path");
  if (value.origin === "external") {
    if (!isAbsolute(value.path)) throw new Error("External paths must be absolute");
    return value.path;
  }
  if (isAbsolute(value.path)) throw new Error(`A ${value.origin} path must be relative`);
  const root = value.origin === "harness" ? context.harnessRoot : value.origin === "runtime" ? context.runtimeRoot : context.projectRoot;
  const result = resolve(root, value.path);
  if (!inside(root, result)) throw new Error(`Path escapes its ${value.origin} owner`);
  return result;
}
/** Permit outside-project reads only at declared immutable worker mounts. */
export function assertProjectInput(path: string, context: RuntimeContext): void {
  const requested = resolve(context.projectRoot, path), actual = realpathSync(requested);
  if (inside(realpathSync(context.projectRoot), actual)) return;
  const input = context.sharedInputs.find(entry => inside(resolve(context.projectRoot, entry.path), requested));
  if (!input || !inside(realpathSync(input.source), actual)) throw new Error(`Input escapes project without a declared shared-input relationship: ${path}`);
}
/** Standalone entrypoints alone discover from argv/cwd. Internal operations do not. */
export function cliRuntimeContext(args: string[], cwd: string): { context: RuntimeContext; args: string[] } {
  const index = args.indexOf("--project"), rest = [...args];
  if (index >= 0 && !args[index + 1]) throw new Error("--project needs a directory");
  const start = index >= 0 ? args[index + 1]! : cwd;
  if (index >= 0) rest.splice(index, 2);
  return { context: createRuntimeContext(start), args: rest };
}
