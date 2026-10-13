import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { projectRoot } from "../../lib/runtimeContext.js";

/** Validate every explicit source before any measurement directory is created. */
export function validateMeasurementSources(sources: readonly string[], root = projectRoot()): void {
  for (const source of sources) {
    const path = isAbsolute(source) ? source : join(root, source);
    let file = false;
    try { file = source.endsWith(".c") && statSync(path).isFile(); } catch { /* Missing is not C input. */ }
    if (!file) throw new Error(`Measurement source must name an existing .c file, not inline C or a directory: ${JSON.stringify(source)}`);
  }
}

/** A cache may be replaced; an experiment's artifacts must not be. */
export function createMeasurementRun(functionName: string, sources: readonly string[], root = projectRoot()): string {
  validateMeasurementSources(sources, root);
  const parent = join(root, "build/pipelineReversal", functionName, "objective");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "measurement-"));
}

/** Evidence copy only: compile the original fragment in its original TU context. */
export function snapshotMeasurementSource(source: string, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const snapshot = join(directory, "selected-source.c");
  writeFileSync(snapshot, readFileSync(source), { flag: "wx" });
  return snapshot;
}

export function assertMeasurementSourceUnchanged(source: string, snapshot: string): void {
  if (!readFileSync(source).equals(readFileSync(snapshot)))
    throw new Error(`Selected source changed during measurement: ${source}. The result was not recorded; repeat from the current source.`);
}
