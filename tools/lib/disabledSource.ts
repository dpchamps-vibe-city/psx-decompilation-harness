/** Keep unknown preprocessor arms visible; omit only literally disabled code.
 * Preserve line numbers for source diagnostics. This is not a preprocessor. */
export function activeSourceText(source: string): string {
  const stack: Array<{ parent: boolean; taken: boolean }> = [];
  let active = true, comment = false;
  const lines = source.split("\n").map(line => {
    let code = "";
    for (let i = 0; i < line.length;) {
      if (comment) { const end = line.indexOf("*/", i); if (end < 0) break; i = end + 2; comment = false; }
      else if (line.startsWith("/*", i)) { comment = true; i += 2; }
      else if (line[i] === '"' || line[i] === "'") {
        const quote = line[i], start = i++;
        while (i < line.length) { if (line[i++] === "\\") i++; else if (line[i - 1] === quote) break; }
        code += line.slice(start, i);
      } else code += line[i++];
    }
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)/.exec(code);
    if (!directive) return active ? line : "";
    const [, op, tail] = directive, condition = tail!.replace(/\/\*.*?\*\//g, "").trim();
    if (["if", "ifdef", "ifndef"].includes(op!)) {
      stack.push({ parent: active, taken: op === "if" && condition === "1" });
      active = active && !(op === "if" && condition === "0");
    } else {
      const frame = stack.at(-1);
      if (!frame) throw new Error("Unbalanced preprocessor conditional");
      if (op === "endif") { active = frame.parent; stack.pop(); }
      else {
        active = frame.parent && !frame.taken && (op === "else" || condition !== "0");
        if (op === "else" || condition === "1") frame.taken = true;
      }
    }
    return "";
  });
  if (stack.length) throw new Error("Unterminated preprocessor conditional");
  return lines.join("\n");
}
