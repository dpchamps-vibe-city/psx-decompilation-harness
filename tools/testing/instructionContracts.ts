import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { filesUnder } from "../lib/contentCache.js";
import ts from "typescript";
import { Value } from "typebox/value";

/** Preserve instruction bytes, not the implementation around tool descriptions. */
export function descriptionSpans(source: string): string[] {
  const file = ts.createSourceFile("tool.ts", source, ts.ScriptTarget.Latest, true), spans: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "description") spans.push(node.initializer.getText(file));
    if (ts.isCallExpression(node) && node.expression.getText(file) === "functionTool" && node.arguments[3]) spans.push(node.arguments[3].getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file); return spans;
}
export interface InstructionFingerprint { file: string; descriptionsOnly: boolean; sha256: string }
export interface InstructionSnapshot { schemaVersion: 1; rows: InstructionFingerprint[] }
/** Current instruction coverage is discovered, not inherited from the one-off
 * installed-runtime migration's historical file list. Implementation-only edits
 * around registered descriptions do not change their fingerprints. */
export function captureInstructionSnapshot(root: string, options: { projectGuide?: boolean } = {}): InstructionSnapshot {
  const wholeFiles = [...(options.projectGuide === false ? [] : ["AGENTS.md"]), ".pi/extensions/psx-decomp/autoloop/prompts.ts",
    ...filesUnder(join(root, ".pi/skills")).filter(p => p.endsWith("/SKILL.md")).map(p => relative(root, p)),
    ...filesUnder(join(root, "prompts/reference")).filter(p => p.endsWith(".md")).map(p => relative(root, p))];
  const descriptions = filesUnder(join(root, ".pi/extensions")).filter(p => p.endsWith(".ts") && !p.endsWith(".test.ts"))
    .map(p => relative(root, p)).filter(p => !wholeFiles.includes(p) && descriptionSpans(readFileSync(join(root, p), "utf8")).length > 0);
  return { schemaVersion: 1, rows: [...wholeFiles, ...descriptions].sort().map(file => {
    const text = readFileSync(join(root, file), "utf8"), descriptionsOnly = !wholeFiles.includes(file);
    const content = descriptionsOnly ? JSON.stringify(descriptionSpans(text)) : text;
    return { file, descriptionsOnly, sha256: createHash("sha256").update(content).digest("hex") };
  }) };
}
export function readInstructionSnapshot(root: string): InstructionSnapshot {
  return JSON.parse(readFileSync(join(root, "test-fixtures/installed-runtime/instruction-current.json"), "utf8"));
}
export function assertInstructionSnapshot(root: string, expected: InstructionSnapshot, options: { projectGuide?: boolean } = {}): void {
  const current = captureInstructionSnapshot(root, options);
  if (options.projectGuide === false) expected = { ...expected, rows: expected.rows.filter(row => row.file !== "AGENTS.md") };
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    const old = new Map(expected.rows.map(row => [row.file, row]));
    const now = new Map(current.rows.map(row => [row.file, row]));
    const changed = [...new Set([...old.keys(), ...now.keys()])].filter(file => JSON.stringify(old.get(file)) !== JSON.stringify(now.get(file)));
    throw new Error(`Unrecorded instruction bytes or inventory: ${changed.join(", ")}. Review the diff before running npm run test:update-instructions.`);
  }
}

export interface InstructionEdit { file: string; kind: string; baselineText: string; newText: string; occurrence?: number }
export function applyRecordedEdits(file: string, source: string, edits: InstructionEdit[]): string {
  for (const edit of edits.filter(e => e.file === file)) {
    const index = source.indexOf(edit.baselineText);
    if (index < 0) throw new Error(`${file}: missing recorded baseline span`);
    if (!edit.occurrence && source.indexOf(edit.baselineText, index + 1) >= 0) throw new Error(`${file}: ambiguous recorded baseline span`);
    source = source.slice(0, index) + edit.newText + source.slice(index + edit.baselineText.length);
  }
  return source;
}
export function assertInstructionBytes(file: string, baseline: string, current: string, edits: InstructionEdit[], descriptionsOnly = false): void {
  const expected = applyRecordedEdits(file, baseline, edits);
  const a = descriptionsOnly ? JSON.stringify(descriptionSpans(expected)) : expected;
  const b = descriptionsOnly ? JSON.stringify(descriptionSpans(current)) : current;
  if (a !== b) throw new Error(`${file}: unrecorded instruction byte difference`);
}
export function inspectInstructionReferences(text: string, file: string, consumer: string, tools: Map<string, { parameters: any }>): void {
  if (/\bmake\s+(?:check(?:-all)?|split(?:-all)?|build|clean|wipe|setup)\b/.test(text)) throw new Error(`${file}: stale Make target`);
  if (/\bnpx\s+tsx\s+tools\//.test(text)) throw new Error(`${file}: stale project-relative invocation`);
  for (const match of text.matchAll(/(?<![.\w/])(?:tools\/[\w./<>-]+\.\w+|\.pi\/skills\/[\w./-]+)/g)) {
    // Authored plugin mutation paths are tested in their prepared workflow.
    const path = match[0].replace(/<format>/g, "fixture");
    if (!existsSync(resolve(consumer, path))) throw new Error(`${file}: missing project mutation/resource path ${path}`);
  }
  for (const match of text.matchAll(/\]\(([^)]+)\)|`(\.\.\/[^`]+|\.\/[^`]+)`/g)) {
    const link = (match[1] ?? match[2]!).split("#")[0]!;
    if (/^(?:https?:|mailto:)/.test(link) || !link) continue;
    if (!existsSync(resolve(dirname(file), link))) throw new Error(`${file}: missing installed resource link ${link}`);
  }
  for (const match of text.matchAll(/\bpsx_[a-z_]+\b/g)) if (!tools.has(match[0])) throw new Error(`${file}: unregistered tool ${match[0]}`);
  // Markdown backticks are not JavaScript template literals. Parse each tool
  // invocation independently so calls inside prose/code fences are checked too.
  const calls = [...text.matchAll(/\bpsx_\w+\s*\(\s*\{[^}]*\}\s*\)/g)].map(m => m[0]).join(";\n");
  const source = ts.createSourceFile("hints.ts", calls, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith("psx_")) {
      const toolName = node.expression.text;
      const schema = tools.get(toolName)?.parameters;
      const object = node.arguments[0];
      if (schema && object && ts.isObjectLiteralExpression(object)) {
        const keys = object.properties.filter(ts.isPropertyAssignment).map(p => p.name.getText(source).replace(/^['"]|['"]$/g, ""));
        for (const key of keys) if (!schema.properties?.[key]) throw new Error(`${file}: invalid ${node.expression.text} parameter ${key}`);
        for (const key of schema.required ?? []) if (!keys.includes(key)) throw new Error(`${file}: missing ${node.expression.text} parameter ${key}`);
        const literal = (value: ts.Expression): unknown => {
          if (ts.isStringLiteral(value)) return value.text;
          if (ts.isNumericLiteral(value)) return Number(value.text);
          if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
          if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
          if (value.kind === ts.SyntaxKind.NullKeyword) return null;
          if (ts.isArrayLiteralExpression(value)) return value.elements.map(v => literal(v as ts.Expression));
          if (ts.isObjectLiteralExpression(value)) return Object.fromEntries(value.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source).replace(/^['"]|['"]$/g, ""), literal(p.initializer)]));
          if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) return -Number(literal(value.operand));
          throw new Error(`${file}: nonliteral ${toolName} follow-up parameter`);
        };
        if (!Value.Check(schema, literal(object))) throw new Error(`${file}: invalid ${node.expression.text} parameter value`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
export function readInstructionLedger(root: string): InstructionEdit[] {
  return JSON.parse(readFileSync(resolve(root, "plans/installed-package-runtime-instruction-edits.json"), "utf8")).entries;
}
