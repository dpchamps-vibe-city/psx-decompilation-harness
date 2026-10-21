import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { aliasKey, aliasLabels, respellLocalLabels, retireAliases } from "./unaliasLibraryTu.js";
import { matchingConstructs } from "./cSourceAnalysis.js";

const locals = new Set(["B_000015B8", "B_00001680", "B_00001B98", "func_00000088", "func_000003F0", "func_00000710"]);
const every = (sources: string[]) => new Set(aliasLabels(sources, locals).retirable);

test("unalias re-spells $L asm labels of local labels only; a $L-spelled C name is a different name", () => {
  assert.equal(respellLocalLabels('x __asm__("$LB_000015B8"); y asm( " $LB_00001680+4"); z __asm__("$L_L00000010"); /* $LB_00001680 */ $LB_00001680',
    locals), 'x __asm__("B_000015B8"); y asm( " B_00001680+4"); z __asm__("$L_L00000010"); /* $LB_00001680 */ $LB_00001680');
});

test("unalias treats a $L-spelled declaration as an alias: kept, it gains a plain asm label; retired, it is renamed", () => {
  const parts = ['extern DsCq $LB_000015B8;\nDsCqCommand *$Lfunc_00000088(void);\nextern s32 B_000015B8 __asm__("$LB_000015B8");\n',
    'void g(void) { $Lfunc_00000088()->x = $LB_000015B8.n; }\n'];
  assert.deepEqual(aliasLabels(parts, locals).labels, [
    { label: "B_000015B8", names: ["$LB_000015B8", "B_000015B8"], offsets: [] }, { label: "func_00000088", names: ["$Lfunc_00000088"], offsets: [] }]);
  assert.deepEqual(retireAliases(parts, locals, new Set()), [
    'extern DsCq $LB_000015B8 __asm__("B_000015B8");\nDsCqCommand *$Lfunc_00000088(void) __asm__("func_00000088");\nextern s32 B_000015B8 __asm__("B_000015B8");\n', parts[1]]);
  assert.deepEqual(retireAliases(parts, locals, new Set([aliasKey("B_000015B8", "$LB_000015B8"), aliasKey("func_00000088", "$Lfunc_00000088")])), [
    'extern DsCq B_000015B8;\nstatic DsCqCommand *func_00000088(void);\nextern s32 B_000015B8 __asm__("B_000015B8");\n',
    'void g(void) { func_00000088()->x = B_000015B8.n; }\n']);
});

test("unalias declares aliased storage plainly and renames its C name through the TU", () => {
  const parts = [
    '/* – non-ASCII before the edits – */\nextern s32 queued __asm__("$LB_00001680");\nint DsQueueLen(void) { return queued; }\n',
    'extern s32 $LB_00001680 __asm__("$LB_00001680");\nvoid f(struct { int queued; } *p) { p->queued = $LB_00001680 + queued; }\n',
  ];
  assert.deepEqual(retireAliases(parts, locals, every(parts)), [
    '/* – non-ASCII before the edits – */\nextern s32 B_00001680;\nint DsQueueLen(void) { return B_00001680; }\n',
    'extern s32 B_00001680;\nvoid f(struct { int queued; } *p) { p->queued = B_00001680 + B_00001680; }\n',
  ]);
});

test("unalias makes a local-label function static wherever it is declared", () => {
  const parts = [
    'extern int func_000003F0(s32 arg0) __asm__("$Lfunc_000003F0");\nvoid g(void) { func_000003F0(1); }\n',
    'int func_000003F0(s32 arg0) __asm__("$Lfunc_000003F0");\nint func_000003F0(s32 arg0) { return arg0; }\n',
    'extern void (*hook)(u8) __asm__("$LB_00001680");\nstatic void flush(DsCommand *) __asm__("$Lfunc_00000088");\n',
  ];
  assert.deepEqual(retireAliases(parts, locals, every(parts)), [
    'static int func_000003F0(s32 arg0);\nvoid g(void) { func_000003F0(1); }\n',
    'static int func_000003F0(s32 arg0);\nstatic int func_000003F0(s32 arg0) { return arg0; }\n',
    'extern void (*B_00001680)(u8);\nstatic void func_00000088(DsCommand *);\n',
  ]);
});

test("unalias keeps offset aliases and aliases outside the retirement set, spelled against the plain label", () => {
  const parts = [
    'extern s32 B_00001B98 __asm__("$LB_00001B98");\nextern s32 rd __asm__("$LB_00001B98+4");\n',
    'extern DsCq q __asm__("$LB_000015B8");\nextern DsResetCq r __asm__("$LB_000015B8");\n#if 0\nextern DsCq z __asm__("$LB_000015B8");\n#endif\n',
  ];
  const { labels, retirable } = aliasLabels(parts, locals);
  assert.deepEqual(labels, [
    { label: "B_00001B98", names: ["B_00001B98"], offsets: ["B_00001B98+4"] },
    { label: "B_000015B8", names: ["q", "r"], offsets: [] },
  ]);
  assert.deepEqual(retirable, [aliasKey("B_00001B98", "B_00001B98"), aliasKey("B_000015B8", "q"), aliasKey("B_000015B8", "r")]);
  assert.deepEqual(retireAliases(parts, locals, new Set([aliasKey("B_00001B98", "B_00001B98"), aliasKey("B_000015B8", "q")])), [
    'extern s32 B_00001B98;\nextern s32 rd __asm__("B_00001B98+4");\n',
    'extern DsCq B_000015B8;\nextern DsResetCq r __asm__("B_000015B8");\n#if 0\nextern DsCq z __asm__("B_000015B8");\n#endif\n',
  ]);
});

test("unalias never retires a name bound to two labels, or a label an offset alias already names", () => {
  const parts = ['extern s32 both __asm__("$LB_00001680");\nextern s32 both __asm__("$LB_00001B98");\nextern s32 B_000015B8 __asm__("$LB_00001680+4");\nextern s32 cq __asm__("$LB_000015B8");\n'];
  assert.deepEqual(aliasLabels(parts, locals).retirable, []);
});

test("asm labels are reported as symbol aliases, apart from register pins", () => {
  const constructs = matchingConstructs('extern int a __asm__("B_00001680");\nstatic void f(void) __asm__("func_00000088");\nvoid g(void) { register int r asm("$2"); }\n');
  assert.deepEqual(constructs.asmLabels, [{ line: 1, name: "a", label: "B_00001680" }, { line: 2, name: "f", label: "func_00000088" }]);
  assert.equal(constructs.localRegisterBindings.length, 1);
});
