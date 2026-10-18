import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { assemblySourceFindings } from "./assemblyPolicy.js";
import { activeSourceText } from "./disabledSource.js";
import { preservedAttempt } from "../agent/cSourceAnalysis.js";
import { inspectLibraryPart } from "./libraryTranslationUnit.js";

test("assembly source audit rejects all executable data, not only valid instruction encodings", () => {
  for (const directive of [".word 0xffffffff", ".word imported", ".half 1", ".byte 3", ".int 0", ".long 0", ".fill 1,4,0", ".space 4,1", '.ascii "\\u0000"'])
    assert.equal(assemblySourceFindings(`.text\n${directive}\n`).length, 1, directive);
  for (const directive of [".space 4", ".space 4,0", '.ascii "A;B#C"', '.asciz "printable"'])
    assert.equal(assemblySourceFindings(`.text\n${directive}\n`).length, 0, directive);
  assert.equal(assemblySourceFindings(".data\n.word 0x03e00008\n").length, 0);
  assert.equal(assemblySourceFindings(".text\n.word 0xbf\n", { sdkPlaceholders: true }).length, 0);
  assert.equal(assemblySourceFindings(".text\n.word 0xbf\n").length, 1);
  assert.equal(assemblySourceFindings(".text\n.word 0x153f\n", { sdkPlaceholders: true }).length, 1);
});
test("disabled attempts are inert to both C-part and assembly audits, but remain available to prep", () => {
  const attempt = "int entry(int x) { return x + 1; }\n";
  const source = 'INCLUDE_ASM("build/libraries/nonmatchings/unit", entry);\n/* PSX parked attempt: evidence */\n#if 0\n' + attempt + "#endif\n";
  assert.equal(inspectLibraryPart(source, { path: "entry.c", symbol: "entry" }).stub, true);
  assert.equal(preservedAttempt(source), attempt);
  const assembly = '.text\nentry:\njr $31\nnop\n#if 0\n.word 0x12345678\n.include "unapproved-path.s"\n#endif\n';
  assert.equal(inspectLibraryPart(assembly, { path: "entry.ASM", symbols: ["entry"] }).stub, false);
  assert.equal(assemblySourceFindings(assembly, { cpp: true }).length, 0);
  assert.equal(assemblySourceFindings(assembly).length, 1, "plain .s does not have preprocessor-disabled arms");
  assert.equal(assemblySourceFindings("#if UNKNOWN\n.word 1\n#else\n.word 2\n#endif\n", { cpp: true }).length, 2);
  assert.equal(inspectLibraryPart("/*\n#if 0\n*/\nint entry(void) { return 1; }\n", { path: "entry.c", symbol: "entry" }).stub, false, "C comments are not preprocessor conditionals");
  const commented = source.replace(attempt, "/*\n#endif\n*/\n" + attempt);
  assert.equal(preservedAttempt(commented), "/*\n#endif\n*/\n" + attempt);
  assert.equal(assemblySourceFindings("/*\n#if 0\n*/\n.word 1\n/*\n#endif\n*/\n", { cpp: true }).length, 1, "comments cannot hide active encodings");
  assert.throws(() => activeSourceText("#if 0\nnop\n"), /Unterminated/);
  assert.throws(() => activeSourceText("#endif\n"), /Unbalanced/);
});
