import { readFileSync } from "node:fs";
import { readLnk } from "/home/dave/Documents/code/psx-decompilation-harness/tools/lib/objectFormats/lnk.ts";
import { libraryMembers } from "/home/dave/Documents/code/psx-decompilation-harness/tools/lib/libraryTargets.ts";
const root = "/home/dave/Documents/code/psyq-decomp";
for (const want of ["libcomb_0", "libcd_4"]) {
  const m = libraryMembers(root).find(x => x.id === want)!;
  const o = m.originalObject!;
  console.log("=== original", want, "records", o.object.records!.length, "symbols", o.object.symbols.length);
  for (const r of o.object.records!) {
    if ([2,6,12,14,18,48].includes(r.opcode)) {
      console.log(`  @0x${r.offset.toString(16)} op${r.opcode} ${r.bytes.subarray(0,40).toString("hex")} ${r.bytes.length>40?"...":""}`);
    }
  }
}
const cand = process.argv[2];
if (cand) {
  const b = readFileSync(cand); const o = readLnk(b);
  console.log("=== candidate", cand, "records", o.records!.length, "symbols", o.symbols.length);
  for (const r of o.records!) {
    if ([2,6,12,14,18,48].includes(r.opcode)) {
      console.log(`  @0x${r.offset.toString(16)} op${r.opcode} ${r.bytes.subarray(0,40).toString("hex")} ${r.bytes.length>40?"...":""}`);
    }
  }
}
