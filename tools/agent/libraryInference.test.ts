import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { alignDefinition, unprototypeDeclarations } from "./libraryInference.js";
import { emptyDeclarationIndex, indexDeclarations, projectDeclarations } from "./declarationContext.js";
import type { Prototype } from "./calleeTruth.js";

const declared = (name: string, returnType: string, paramTypes: string[], variadic = false): Prototype =>
  ({ name, signature: "", parameters: paramTypes.length, variadic, returnsVoid: returnType === "void", returnType, paramTypes, kind: "declaration", where: "sdk.h", line: 1 } as Prototype);

test("a definition spells the reference declaration's types, keeping m2c's parameter names", () => {
  assert.equal(alignDefinition("void SsSeqSetAccelerando(s16 arg0, s32 arg1, s32 arg2) {\n    f(arg0);\n}\n", declared("SsSeqSetAccelerando", "void", ["short", "long", "long"])),
    "void SsSeqSetAccelerando(short arg0, long arg1, long arg2) {\n    f(arg0);\n}\n", "long is int's size but a conflicting type");
  assert.equal(alignDefinition("CdlLOC *CdIntToPos(s32 i, CdlLOC *p) {\n    return p;\n}\n", declared("CdIntToPos", "CdlLOC *", ["int", "CdlLOC *"])),
    "CdlLOC *CdIntToPos(int i, CdlLOC *p) {\n    return p;\n}\n");
  assert.equal(alignDefinition("s32 Hook(void *arg0) {\n    return 0;\n}\n", declared("Hook", "int", ["void (*)(int)"])),
    "int Hook(void (*arg0)(int)) {\n    return 0;\n}\n", "a function-pointer parameter is named inside its declarator");
  assert.equal(alignDefinition("void Off(void) {\n}\n", declared("Off", "void", [])), "void Off(void) {\n}\n");
  const mismatched = "void Two(s32 arg0) {\n}\n";
  assert.equal(alignDefinition(mismatched, declared("Two", "void", ["long", "long"])), mismatched, "a different arity is m2c's disagreement to report, not to paper over");
});

test("callees called with fewer arguments than they read are declared without a prototype", () => {
  const raw = "void _SsSndSetPauseMode(s16 arg0, s16 arg1, ? arg2, s16 *arg3); /* static */\ns32 Other(s32);\n\nvoid SsSeqPause(short arg0) {\n    _SsSndSetPauseMode(arg0, 0);\n}\n";
  assert.equal(unprototypeDeclarations(raw, ["_SsSndSetPauseMode"]),
    "void _SsSndSetPauseMode(); /* static */\ns32 Other(s32);\n\nvoid SsSeqPause(short arg0) {\n    _SsSndSetPauseMode(arg0, 0);\n}\n");
  assert.equal(unprototypeDeclarations(raw, []), raw);
});

test("projected declarations keep no blank line inside, so blank lines separate declarations only", () => {
  const index = emptyDeclarationIndex();
  indexDeclarations(index, "typedef struct VagAtr {\n  short prog;\n  short reserved[4];\n\n} VagAtr;\nshort SsUtSetVagAtr(short, VagAtr *);\n", "sdk.h", "public", "public-header");
  const text = projectDeclarations(index, ["SsUtSetVagAtr"], "public").text;
  assert.ok(text.split(/\n\n/).some(block => block.startsWith("struct VagAtr {") && block.trimEnd().endsWith("};")), text);
});
