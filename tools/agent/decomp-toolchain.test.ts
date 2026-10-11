import { strict as assert } from "node:assert";
import { test } from "../testing/runtimeTestContext.js";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import {
  configuredAsFlagsForContainer,
  configuredCc1FlagsForContainer,
  containerForSymbol,
  containerKindForSymbol,
  parseImplicitDeclarationWarnings,
  resolveAsmSource,
  sourceDirFor,
  sourcePathFor,
} from "./decompToolchain.js";

test("extracts each undeclared callee once from cc1 -Wimplicit stderr", () => {
  const stderr = [
    "probe.c: In function `func_80022738':",
    "probe.c:4: warning: implicit declaration of function `SetVal8005E2BC'",
    "probe.c:5: warning: implicit declaration of function `SetVal8005E334'",
    "probe.c:7: warning: implicit declaration of function `SetVal8005E334'",
  ].join("\n");
  assert.deepEqual(parseImplicitDeclarationWarnings(stderr), [
    "SetVal8005E2BC",
    "SetVal8005E334",
  ]);
});

test("ignores other -Wimplicit forms and unrelated diagnostics", () => {
  const stderr = [
    "probe.c:3: warning: type defaults to `int' in declaration of `x'",
    "probe.c:9: warning: unused variable `p'",
    "",
  ].join("\n");
  assert.deepEqual(parseImplicitDeclarationWarnings(stderr), []);
});

test("empty stderr means every callee is declared", () => {
  assert.deepEqual(parseImplicitDeclarationWarnings(""), []);
});

test("a symbol's container comes from its own name", (t) => {
  const { root } = projectFixture(t);
  assert.equal(containerKindForSymbol("fixture_entry", root), "exe");
  assert.equal(containerForSymbol("fixture_entry", root)?.id, "exe");
  assert.equal(containerKindForSymbol("ovl_fixture_helper", root), "overlay");
  assert.equal(containerForSymbol("ovl_fixture_helper", root)?.id, "ovl_fixture");
  assert.equal(containerKindForSymbol("probe_stem", root), "exe", "unclaimed probe stems keep the image default");
});

test("source and assembly resolve into the symbol's own container", (t) => {
  const { root } = projectFixture(t);
  assert.equal(sourcePathFor("fixture_entry", root), join(root, "src/fixture_entry.c"));
  assert.equal(sourcePathFor("ovl_fixture_helper", root), join(root, "src/overlays/ovl_fixture/ovl_fixture_helper.c"));
  assert.equal(sourceDirFor("ovl_fixture_helper", root), join(root, "src/overlays/ovl_fixture"));
  const asm = resolveAsmSource("ovl_fixture_helper", root);
  assert.equal(asm, join(root, "build/ovl_fixture/asm/nonmatchings/ovl_fixture_helper/ovl_fixture_helper.s"));
});

test("unselected overlay profiles inherit base flags without guessing -G0", () => {
  assert.deepEqual(configuredCc1FlagsForContainer("overlay"), configuredCc1FlagsForContainer("exe"));
  assert.deepEqual(configuredAsFlagsForContainer("overlay"), configuredAsFlagsForContainer("exe"));
});
