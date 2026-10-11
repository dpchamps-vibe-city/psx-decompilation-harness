import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LibraryProject } from "../lib/project.js";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { legacyLibrarySource } from "../lib/librarySourceLayout.js";
import { migrateLibrarySources } from "./librarySources.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "psx-library-source-move-"));
  const project = { output: { sourceDir: "src/libraries", sourceLayout: "grouped", inputRoot: "input" } } as LibraryProject;
  const members = [
    { id: "lib_first_0", member: "0-unit.o", source: "src/libraries/liba/0-unit.c" },
    { id: "lib_second_0", member: "1-unit.o", source: "src/libraries/libb/1-unit.c" },
  ] as LibraryMember[];
  const oldPath = (member: LibraryMember) => legacyLibrarySource(project, member.id, member.member);
  const put = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  return { root, project, members, oldPath, put };
}

test("source layout migration preserves complete edited C and INCLUDE_ASM TUs byte-for-byte and is idempotent", () => {
  const f = fixture();
  try {
    const contents = ["#include \"common.h\"\nint existing_work(void) { return 7; }\n",
      "#include \"include_asm.h\"\nINCLUDE_ASM(\"build/libraries/nonmatchings/lib_second_0\", neighbor);\n"];
    f.members.forEach((member, i) => f.put(f.oldPath(member), contents[i]!));
    const moved = migrateLibrarySources(f.members, f.project, f.root);
    assert.equal(moved.length, 2);
    f.members.forEach((member, i) => {
      assert.equal(readFileSync(join(f.root, member.source), "utf8"), contents[i]);
      assert.equal(existsSync(join(f.root, f.oldPath(member))), false);
      assert.equal(existsSync(dirname(join(f.root, f.oldPath(member)))), false);
    });
    assert.deepEqual(migrateLibrarySources(f.members, f.project, f.root), []);
    const report = JSON.parse(readFileSync(join(f.root, "build/libraries/source-migration.json"), "utf8"));
    assert.deepEqual(report.moves, moved);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("all source conflicts are detected before moving any earlier member", () => {
  const f = fixture();
  try {
    for (const member of f.members) f.put(f.oldPath(member), "int old_work(void) { return 1; }\n");
    f.put(f.members[1]!.source, "int different_work(void) { return 2; }\n");
    assert.throws(() => migrateLibrarySources(f.members, f.project, f.root), /Conflicting library sources/);
    assert.equal(existsSync(join(f.root, f.members[0]!.source)), false);
    for (const member of f.members) assert.equal(existsSync(join(f.root, f.oldPath(member))), true);
    assert.match(readFileSync(join(f.root, f.members[1]!.source), "utf8"), /different_work/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("identical duplicate source copies are consolidated without choosing between edits", () => {
  const f = fixture();
  try {
    const member = f.members[0]!, content = "int work(void) { return 9; }\n";
    f.put(f.oldPath(member), content); f.put(member.source, content);
    assert.equal(migrateLibrarySources([member], f.project, f.root)[0]!.action, "deduplicated");
    assert.equal(readFileSync(join(f.root, member.source), "utf8"), content);
    assert.equal(existsSync(join(f.root, f.oldPath(member))), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("source migration refuses broken C, relative/computed includes and neighboring files", () => {
  for (const content of ["int broken(\n", "#include \"../local.h\"\n", "#include HEADER\n"]) {
    const f = fixture();
    try {
      const member = f.members[0]!; f.put(f.oldPath(member), content);
      assert.throws(() => migrateLibrarySources([member], f.project, f.root), /invalid C|include-path review/);
      assert.equal(existsSync(join(f.root, f.oldPath(member))), true);
      assert.equal(existsSync(join(f.root, member.source)), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = fixture();
  try {
    const member = f.members[0]!; f.put(f.oldPath(member), "#include \"local.h\"\n");
    f.put(join(dirname(f.oldPath(member)), "local.h"), "typedef int Local;\n");
    assert.throws(() => migrateLibrarySources([member], f.project, f.root), /neighboring files/);
    assert.equal(existsSync(join(f.root, f.oldPath(member))), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
