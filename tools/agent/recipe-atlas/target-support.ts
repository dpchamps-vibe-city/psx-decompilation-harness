/** Atlas columns currently cover linked-image exe/overlay profiles only.
 * Refuse library lookups before an EXE resolver or catalogue compile can run.
 * A section coordinate is not an image address, nor an exe flag column. */
import { loadLibraryProject } from "../../lib/project.js";

export class UnsupportedRecipeAtlasTarget extends Error {
  readonly status = "unsupported-target";
  readonly targetKind = "relocatable-library";
  constructor(readonly tool: string) {
    super(`${tool}: relocatable-library targets are not supported by the recipe atlas's exe/overlay flag columns and image-coordinate repair path. No PS-X EXE lookup or recipe compilation was attempted. Use explicit candidate diagnostics with the owning-TU oracle.`);
    this.name = "UnsupportedRecipeAtlasTarget";
  }
}

export function requireRecipeAtlasImageSupport(tool: string): void {
  if (loadLibraryProject()) throw new UnsupportedRecipeAtlasTarget(tool);
}

export function reportUnsupportedRecipeAtlasTarget(error: unknown, json: boolean): void {
  if (!(error instanceof UnsupportedRecipeAtlasTarget)) throw error;
  if (json) console.log(JSON.stringify({ status: error.status, targetKind: error.targetKind, tool: error.tool, reason: error.message }, null, 2));
  else console.error(error.message);
  process.exitCode = 2;
}
