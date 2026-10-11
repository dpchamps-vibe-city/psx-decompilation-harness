import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRuntimeContext, type RuntimeContext, type SharedInput } from "./runtimeContext.js";

/** Declare only immutable leaf inputs. Extraction destinations and all lib/build
 * writes remain workspace-owned. Never initialize consumer submodules. */
export function prepareWorkspaceInputs(parent: string, workspace: string): RuntimeContext {
  parent = resolve(parent); workspace = resolve(workspace);
  const sharedInputs: SharedInput[] = [];
  function leaves(directory: string): void {
    const source = join(parent, directory);
    if (!existsSync(source)) return;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`, original = join(parent, path), destination = join(workspace, path);
      if (entry.isDirectory()) { mkdirSync(destination, { recursive: true }); leaves(path); }
      else {
        // Derived overlay/member extractions are private copies, not writable
        // mounts into another workspace's extracted tree.
        if (/^extracted\/(overlays|archives|members)(\/|$)/.test(path)) {
          if (!existsSync(destination)) { mkdirSync(dirname(destination), { recursive: true }); cpSync(original, destination); }
          continue;
        }
        const stat = lstatSync(destination, { throwIfNoEntry: false });
        if (!stat) { mkdirSync(dirname(destination), { recursive: true }); symlinkSync(original, destination); }
        else if (!stat.isSymbolicLink()) continue; // tracked/worktree-owned input
        sharedInputs.push({ path, source: original });
      }
    }
  }
  leaves("extracted"); leaves("library-input");
  // lib may be an authoritative target OR a conversion destination. A private
  // copy supports both without giving a worker writes into its parent's lib.
  function privateCopy(source: string, destination: string): void {
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      const existing = lstatSync(destination, { throwIfNoEntry: false });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Worker private input is not a directory: ${destination}`);
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(source)) privateCopy(join(source, entry), join(destination, entry));
    } else {
      const existing = lstatSync(destination, { throwIfNoEntry: false });
      if (existing?.isSymbolicLink()) throw new Error(`Worker writable input must not be a shared symlink: ${destination}`);
      if (existing && !readFileSync(source).equals(readFileSync(destination))) throw new Error(`Worker input differs from the declared parent: ${destination}`);
      if (!existing) { mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { dereference: true }); }
    }
  }
  for (const directory of ["lib", "build/dependencies"]) {
    const source = join(parent, directory), destination = join(workspace, directory);
    if (existsSync(source)) privateCopy(source, destination);
  }
  const context = createRuntimeContext(workspace, { parentProjectRoot: parent, sharedInputs });
  mkdirSync(context.runtimeRoot, { recursive: true });
  writeFileSync(join(context.runtimeRoot, "runtime-context.json"), JSON.stringify({ schemaVersion: 1, projectRoot: workspace, parentProjectRoot: parent, sharedInputs }, null, 2) + "\n");
  return context;
}
