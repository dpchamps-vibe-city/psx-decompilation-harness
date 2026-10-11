/** Project-owned Make assignment syntax, read as data, never executed. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FLAG_OVERRIDE_FILE = "configs/flag_overrides.mk";
export const FLAG_OVERRIDE_HEADER = "# Per-file cc1 overrides. Evidence comment directly above each entry.\n# CC1FLAGS_<source-basename-without-.c> := <extra cc1 flags>\n";

export function readFlagOverrides(projectRoot: string): Map<string, string[]> {
  const file = join(projectRoot, FLAG_OVERRIDE_FILE);
  const overrides = new Map<string, string[]>();
  if (!existsSync(file)) return overrides;
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^CC1FLAGS_(\S+)\s*:=\s*(.+)$/);
    if (!match || !match[2]!.trim()) throw new Error(`${file}:${index + 1}: unsupported override; expected CC1FLAGS_<stem> := <extra cc1 flags>`);
    // Match the existing compile readers. This is an argv list, not a shell or
    // Make expansion language; assignments/directives outside this grammar fail.
    overrides.set(match[1]!, match[2]!.trim().split(/\s+/));
  }
  return overrides;
}

export function fileOverrideFlags(projectRoot: string, stem: string): string[] {
  return [...(readFlagOverrides(projectRoot).get(stem) ?? [])];
}
