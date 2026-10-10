import assert from "node:assert/strict";
import test from "node:test";
import { selectedCSources } from "./pipeline.js";
import type { Container } from "../lib/container.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT } from "../lib/psxExeInfo.js";

test("overlay builds select configured functions without deleting retired source files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "overlay-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["configs/splat", "src/overlays/ovl_test"]) mkdirSync(join(root, dir), { recursive: true });
  const container = { id: "ovl_test", kind: "overlay", paths: { srcDir: "src/overlays/ovl_test", splat: "configs/splat/ovl_test.yaml" } } as Container;
  const live = "src/overlays/ovl_test/head.c", retired = "src/overlays/ovl_test/case.c";
  writeFileSync(join(root, live), "int head(void) {return 1;}\n");
  const stub = 'INCLUDE_ASM("build/nonexistent/case", case);\n';
  writeFileSync(join(root, retired), stub);
  const config = join(root, "configs/splat/ovl_test.yaml");
  const selected = () => selectedCSources(container, root).map(p => relative(root, p));
  writeFileSync(config, "subsegments:\n  - [0x0, .rodata, head]\n  - [0x10, c, head]\n  - [0x18, c, case]\n  - [0x20, data]\n");
  assert.deepEqual(selected(), [live, retired]);
  writeFileSync(config, "subsegments:\n  - [0x0, .rodata, head]\n  - [0x10, c, head]\n  - [0x20, data]\n");
  assert.deepEqual(selected(), [live]);
  assert.equal(readFileSync(join(root, retired), "utf8"), stub, "retired source remains untouched, with no standalone asm prerequisite");
});
