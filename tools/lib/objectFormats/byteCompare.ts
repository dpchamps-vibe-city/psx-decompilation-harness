/** Original-object acceptance is whole-file SHA-256, never link equivalence. */
import { createHash } from "node:crypto";
import { readLnk } from "./lnk.js";
import type { ObjectComparison } from "../relocatableObject.js";
export function compareObjectBytes(original: Buffer, candidate: Buffer): ObjectComparison {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const originalHash = sha(original), candidateHash = sha(candidate), same = originalHash === candidateHash;
  const result: ObjectComparison = { verdict: same ? "match" : "mismatch", originalHash, candidateHash,
    matchedWords: 0, totalWords: 0, candidateWords: 0, differences: [] };
  try {
    const a = readLnk(original), b = readLnk(candidate);
    for (const s of a.sections.filter(s => s.kind === "code")) {
      const c = b.sections.find(c => c.name === s.name);
      result.totalWords += Math.ceil(s.size / 4);
      for (let offset = 0; offset < s.size; offset += 4)
        if (c && s.data.subarray(offset, offset + 4).equals(c.data.subarray(offset, offset + 4))) result.matchedWords++;
    }
    result.candidateWords = b.sections.filter(s => s.kind === "code").reduce((n, s) => n + Math.ceil(s.size / 4), 0);
    if (!same) {
      const ar = a.records!, br = b.records!;
      const index = Array.from({ length: Math.max(ar.length, br.length) }, (_, i) => i).find(i => !ar[i]?.bytes.equals(br[i]?.bytes ?? Buffer.alloc(0)))!;
      const describe = (r: typeof ar[number] | undefined) => r ? `opcode ${r.opcode} at 0x${r.offset.toString(16)} (${r.bytes.length} bytes, ${r.bytes.subarray(0, 32).toString("hex")}${r.bytes.length > 32 ? "…" : ""})` : "missing";
      result.differences.push(`First differing .OBJ record #${index}: original ${describe(ar[index])}; rebuilt ${describe(br[index])}`);
    }
  } catch (error) {
    if (!same) result.differences.push(`Cannot compare .OBJ records: ${String(error)}`);
  }
  if (!same) result.differences.unshift(`SHA-256 differs: original ${originalHash}; rebuilt ${candidateHash}`);
  return result;
}
