/** Source-level encoding audit shared by assembly TUs, image builds and policy
 * scans. Executable constants must be instructions/macros, not raw encodings.
 * Symbolic address tables and explicitly non-executable data remain source. */
import { activeSourceText } from "./disabledSource.js";
import { isDmpsxPlaceholderExpression } from "./stages/psyqDmpsx.js";
export function assemblySourceFindings(source: string, options: { sdkPlaceholders?: boolean; cpp?: boolean } = {}) {
  const findings: Array<{ line: number; message: string; text: string }> = [], stack: boolean[] = [];
  let executable = true, blockComment = false, definition = false;
  (options.cpp ? activeSourceText(source) : source).split("\n").forEach((raw, i) => {
    const define = !blockComment && /^\s*#\s*define\b/.test(raw);
    if (define || definition) {
      const body = define ? raw.replace(/^\s*#\s*define\s+\w+(?:\([^)]*\))?\s*/, "") : raw;
      definition = /\\\r?$/.test(raw);
      if (/(?:^|;)\s*\.(?:word|int|long|4byte|byte|short|half|2byte|fill|space|reloc|incbin)\b/.test(body)) findings.push({ line: i + 1, message: "Local encoding macros are not reconstructed assembly; use SDK operations or evidence-backed shared headers", text: raw.trim() });
      return;
    }
    const statements = [""];
    for (let at = 0; at < raw.length;) {
      if (blockComment) { const end = raw.indexOf("*/", at); if (end < 0) break; at = end + 2; blockComment = false; }
      else if (raw.startsWith("/*", at)) { blockComment = true; at += 2; }
      else if (raw[at] === '"') {
        const start = at++;
        while (at < raw.length) { if (raw[at++] === "\\") at++; else if (raw[at - 1] === '"') break; }
        statements[statements.length - 1] += raw.slice(start, at);
      } else if (raw[at] === ";") { statements.push(""); at++; }
      else { if (raw[at] === "#") break; statements[statements.length - 1] += raw[at++]; }
    }
    for (const statement of statements) {
      const text = statement.trim().replace(/^[\w.$]+:\s*/, "");
      if (/^\.pushsection\b/.test(text)) stack.push(executable);
      if (/^\.popsection\b/.test(text)) { executable = stack.pop() ?? true; continue; }
      const section = /^\.(?:pushsection|section)\s+([^\s,]+)(?:\s*,\s*"([^"]*)")?/.exec(text);
      if (section) executable = /^(?:\.text|\.init|\.fini)$/.test(section[1]!) || !!section[2]?.includes("x");
      else if (/^\.(text|init|fini)\b/.test(text)) executable = true;
      else if (/^\.(data|rdata|rodata|sdata|bss|sbss)\b/.test(text)) executable = false;
      if (/^\.(incbin|reloc)\b/.test(text)) findings.push({ line: i + 1, message: "Copied binary/relocation directives are not reconstructed assembly", text: raw.trim() });
      const sdkWord = options.sdkPlaceholders && /^\.word\b\s*(.+)$/.exec(text);
      if (sdkWord && isDmpsxPlaceholderExpression(sdkWord[1]!)) continue;
      if (!executable) continue;
      const ascii = /^\.(?:ascii|asciz)\b\s*(.*)$/.exec(text);
      if (ascii) {
        const strings = ascii[1]!.match(/"(?:\\.|[^"\\])*"/g) ?? [];
        let printable = strings.length > 0 && !ascii[1]!.replace(/"(?:\\.|[^"\\])*"/g, "").replace(/[,\s]/g, "");
        try { printable = !!printable && strings.every(s => /^[\x20-\x7e]*$/.test(JSON.parse(s))); } catch { printable = false; }
        if (printable) continue;
      }
      const space = /^\.space\b\s*([^,]+)(?:,\s*(.*))?$/.exec(text);
      if (space && (space[2] === undefined || /^(?:0x0+|0+)$/i.test(space[2].trim()))) continue;
      if (ascii || space || /^\.(?:word|int|long|4byte|byte|short|half|2byte|fill)\b/.test(text))
        findings.push({ line: i + 1, message: "Data directives in executable storage are forbidden; write instructions or SDK operations", text: raw.trim() });
    }
  });
  return findings;
}
/** sdkPlaceholders is for already-preprocessed source only, after the original
 * source audit and only with the declared DMPSX stage selected. */
export function assertAssemblySource(source: string, path: string, options: { sdkPlaceholders?: boolean; cpp?: boolean } = {}) {
  const finding = assemblySourceFindings(source, options)[0];
  if (finding) throw new Error(`${path}:${finding.line}: ${finding.message}: ${finding.text}`);
}
