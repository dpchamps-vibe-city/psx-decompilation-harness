/** Read-only census of hand-written-code fingerprints over every member: the
 * validation gate for the classifier rules that mark retained functions. A rule
 * is sound for a corpus only when it hits no function already written as C and
 * no GTE (COP2) function, which Sony wrote in C with INLINE_C macros. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { libraryMembers, libraryTargetKey } from "../lib/libraryTargets.js";
import { libraryMemberOrigin } from "../lib/libraryAssembly.js";
import { isDirectoryTu, libraryAssemblyTu, libraryTuStatus } from "../lib/libraryTranslationUnit.js";
import { classifyLibraryCode, type LibraryAssemblyClass } from "./libraryCodeClass.js";

export interface CodeClassRow {
  key: string;
  form: "c" | "assembly";
  origin: "c" | "assembly";
  part: "stub" | "c" | "retained" | "assembly" | "unsplit";
  class?: LibraryAssemblyClass["kind"];
  detail?: string;
  cop2Words: number;
}
export interface CodeClassCensus {
  rows: CodeClassRow[];
  /** Distinct `break` words in GCC-compiled (C-origin) members, with counts. */
  compiledBreakWords: Record<string, number>;
  /** Fingerprinted stubs of C members that split has not flagged yet. */
  unflagged: string[];
  failures: string[];
}

export function libraryCodeClassCensus(root = projectRoot()): CodeClassCensus {
  const rows: CodeClassRow[] = [], compiledBreakWords: Record<string, number> = {};
  for (const member of libraryMembers(root)) {
    const assembly = !!libraryAssemblyTu(member, root), origin = libraryMemberOrigin(member);
    const status = !assembly && isDirectoryTu(member) && existsSync(join(root, member.source)) ? libraryTuStatus(member, root) : undefined;
    for (const fn of member.functions) {
      const evidence = classifyLibraryCode(member.object, fn), section = member.object.sections.get(fn.section);
      let cop2Words = 0;
      for (let offset = fn.offset; section && offset + 4 <= Math.min(fn.offset + fn.size, section.data.length); offset += 4) {
        const word = section.data.readUInt32LE(offset), op = word >>> 26;
        if (op === 0x12 || op === 0x32 || op === 0x3a) cop2Words++;
        if (origin === "c" && op === 0 && (word & 63) === 0x0d) {
          const name = `0x${word.toString(16).padStart(8, "0")}`;
          compiledBreakWords[name] = (compiledBreakWords[name] ?? 0) + 1;
        }
      }
      const row = status?.find(p => p.symbol === fn.name);
      rows.push({ key: libraryTargetKey(member, fn.name), form: assembly ? "assembly" : "c", origin,
        part: assembly ? "assembly" : !row ? "unsplit" : row.retained ? "retained" : row.stub ? "stub" : "c",
        ...(evidence ? { class: evidence.kind, detail: evidence.detail } : {}), cop2Words });
    }
  }
  const hits = rows.filter(r => r.form === "c" && r.class);
  return { rows, compiledBreakWords,
    unflagged: hits.filter(r => r.part === "stub").map(r => r.key),
    failures: [
      ...hits.filter(r => r.part === "c").map(r => `${r.key}: written as C, but fingerprinted as hand-written (${r.detail})`),
      ...hits.filter(r => r.cop2Words > 0).map(r => `${r.key}: a GTE function fingerprinted as hand-written (${r.detail})`),
    ] };
}

export function renderCodeClassCensus(census: CodeClassCensus): string {
  const tally = (rows: CodeClassRow[]) => Object.entries(rows.reduce<Record<string, number>>((t, r) => ({ ...t, [r.class!]: (t[r.class!] ?? 0) + 1 }), {}))
    .map(([kind, n]) => `${kind} ${n}`).join(", ") || "none";
  const classified = census.rows.filter(r => r.class);
  return [
    `C-member functions fingerprinted as hand-written: ${classified.filter(r => r.form === "c").length} (${tally(classified.filter(r => r.form === "c"))})`,
    ...classified.filter(r => r.form === "c").map(r => `  ${r.part.toUpperCase()}\t${r.key}\t${r.detail}`),
    `Assembly-member functions fingerprinted: ${classified.filter(r => r.form === "assembly").length}/${census.rows.filter(r => r.form === "assembly").length} (${tally(classified.filter(r => r.form === "assembly"))})`,
    `break words in GCC-compiled members: ${Object.entries(census.compiledBreakWords).map(([w, n]) => `${w} x${n}`).join(", ") || "none"}`,
    `Unflagged C-member fingerprints (split records them): ${census.unflagged.length}`,
    census.failures.length ? `GATE FAILED:\n${census.failures.map(f => `  ${f}`).join("\n")}` : "Gate passed: no fingerprint on C source or on a GTE function.",
  ].join("\n");
}
