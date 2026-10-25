/** Diagnostic input only: spimdisasm's readonly code-label tables may have
 * ordinary RO_* names, while m2c recognises switches by a label prefix. Never
 * rename original/split symbols or change the assembler's production input. */
export function normalizeM2cJumpTables(listing: string): { text: string; renames: Array<{ from: string; to: string }> } {
  const codeLabels = new Set([...listing.matchAll(/^\s*jlabel\s+(\S+)/gm)].map(m => m[1]!));
  const sections = [...listing.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  // Also reserve imports/references: an undefined symbol may already use an
  // otherwise convenient alias. Reserving comment tokens is conservative.
  const labels = new Set(listing.match(/[A-Za-z_.$][\w.$]*/g) ?? []);
  const renames = new Map<string, string>();
  for (let i = 0; i < sections.length; i++) {
    if (![".rdata", ".rodata"].includes(sections[i]![1]!)) continue;
    const text = listing.slice(sections[i]!.index!, sections[i + 1]?.index ?? listing.length);
    for (const block of text.matchAll(/^dlabel\s+(\S+)\s*\n([\s\S]*?)^enddlabel\s+\1\s*$/gm)) {
      const name = block[1]!;
      if (/^(?:jtbl|jpt_|lbl_|jumptable_)/.test(name)) continue;
      const body = block[2]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#[^\n]*/g, "");
      const lines = body.split("\n").map(l => l.trim()).filter(l => l && !/^\.align\s+2$/.test(l));
      const words = lines.map(l => /^\.word\s+(\S+)$/.exec(l)?.[1]);
      // Only a sequence of witnessed jlabels followed by optional zero padding.
      // Callback arrays, strings, mixed directives and mutable storage stay put.
      let entries = 0, padding = false;
      if (!words.every(word => {
        if (word && /^(?:0|0x0+)$/i.test(word)) { padding = true; return true; }
        if (!padding && word && codeLabels.has(word)) { entries++; return true; }
        return false;
      }) || entries < 2) continue;
      let alias = `jtbl_${name}`;
      for (let n = 1; labels.has(alias); n++) alias = `jtbl_${name}_${n}`;
      labels.add(alias); renames.set(name, alias);
    }
  }
  // Token replacement must not touch .asciz payloads or comments.
  const text = listing.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|#[^\n]*|[A-Za-z_.$][\w.$]*/g,
    token => renames.get(token) ?? token);
  return { text, renames: [...renames].map(([from, to]) => ({ from, to })) };
}
