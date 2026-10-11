import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Explicit cleanup never equates research records with disposable builds.
 * Unknown trees are retained rather than guessing away an evidence artifact. */
const DERIVED_DIRECTORIES = new Set(["asm", "src", "functions", "without-unknown", "cache", "contentCache", "dependencies", "vendor"]);
export function cleanRuntime(runtime: string): void {
  if (!existsSync(runtime)) return;
  for (const entry of readdirSync(runtime, { withFileTypes: true })) {
    if (entry.isDirectory() && (DERIVED_DIRECTORIES.has(entry.name) || /^ovl_\d+$/.test(entry.name))) rmSync(join(runtime, entry.name), { recursive: true, force: true });
    else if (entry.isFile() && /\.(elf|bin|map|ld|o|i|s|d|sha256|stamp)(\.inputs\.json)?$/.test(entry.name)) rmSync(join(runtime, entry.name), { force: true });
  }
  // experimentLedger (rows, sources, closures), preparation evidence/sources,
  // loop threshold observations, measurements and other reports stay accessible.
}
