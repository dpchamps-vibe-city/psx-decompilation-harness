/** PSY-Q LNK v2 grammar. Offsets on patches are relative to the most recent
 * BYTES record, not the section start. No magic scanning or unknown skipping.
 * Layout evidence: the locally vendored PSY-Q object parser's record grammar. */
import { ObjectCursor, type Expression, type NativeObject, type NativeSection, type NativeSymbol, type RelocationKind } from "./model.js";
const kinds: Record<number, RelocationKind> = { 16: "REFWORD", 74: "JMPADDR", 82: "REFHI", 84: "REFLO", 100: "GPREL", 30: "GPREL" };
export function readLnk(bytes: Buffer): NativeObject {
  const r = new ObjectCursor(bytes, "LNK");
  if (r.take(4).toString("hex") !== "4c4e4b02") throw new Error("LNK: expected version 2");
  const sections = new Map<number, NativeSection & { chunks: Buffer[]; pointer: number }>(), symbols = new Map<number, NativeSymbol>();
  const locals: NativeSymbol[] = [], files: string[] = [], records: NonNullable<NativeObject["records"]> = [];
  const patches: Array<{ section: number; offset: number; kind: RelocationKind; expression: Expression }> = [];
  let current: number | undefined, processor: number | undefined, ended = false;
  const section = () => { const s = current === undefined ? undefined : sections.get(current); if (!s) throw new Error(`LNK: undefined current section ${current}`); return s; };
  const expression = (depth = 0): Expression => {
    if (depth > 64) throw new Error("LNK: expression depth exceeds 64");
    const op = r.u8();
    if (op === 0) return { op: "value", value: r.u32() };
    const leaf = ({ 2: "symbol", 4: "base", 12: "start", 22: "end" } as const)[op];
    if (leaf) return { op: leaf, id: r.u16() };
    const binary = ({ 44: "add", 46: "sub", 50: "div" } as const)[op];
    if (binary) {
      // PSY-Q prefix expressions serialize the right operand before the left.
      const right = expression(depth + 1), left = expression(depth + 1);
      return { op: binary, left, right };
    }
    throw new Error(`LNK: unknown expression ${op} at ${r.pos - 1}`);
  };
  const addSymbol = (id: number, s: NativeSymbol) => { if (symbols.has(id)) throw new Error(`LNK: duplicate symbol ${id}`); symbols.set(id, { ...s, id }); };
  while (r.pos < bytes.length) {
    const start = r.pos, opcode = r.u8();
    switch (opcode) {
      case 0: ended = true; break;
      case 2: {
        const data = r.take(r.u16()), s = section(); s.pointer = s.size;
        if (s.kind === "bss" && data.length) { s.kind = "data"; s.chunks.push(Buffer.alloc(s.size)); } // Explicit initialized storage wins over a conventional name.
        s.chunks.push(data); s.size += data.length; break;
      }
      case 6: current = r.u16(); section(); break;
      case 8: {
        const n = r.u32(), s = section();
        if (s.size + n > 0x10000000) throw new Error("LNK: section exceeds supported 256 MiB extent");
        s.size += n; if (s.kind !== "bss") s.chunks.push(Buffer.alloc(n)); break;
      }
      case 10: {
        const raw = r.u8(), kind = kinds[raw]; if (!kind) throw new Error(`LNK: unsupported patch kind ${raw}`);
        const offset = r.u16() + section().pointer;
        patches.push({ section: current!, offset, kind, expression: expression() }); break;
      }
      case 12: case 48: {
        const id = r.u16(), sid = r.u16(), value = r.u32(), name = r.text();
        if (!sections.has(sid)) throw new Error(`LNK: undefined symbol section ${sid}`);
        addSymbol(id, { name, section: opcode === 48 ? "COMMON" : sections.get(sid)!.name, offset: opcode === 48 ? 0 : value, size: opcode === 48 ? value : 0, binding: "external" }); break;
      }
      case 14: { const id = r.u16(); addSymbol(id, { name: r.text(), section: "UND", offset: 0, size: 0, binding: "external" }); break; }
      case 16: {
        const id = r.u16(); r.u16(); const alignment = r.u8(), name = r.text();
        if (sections.has(id) || [...sections.values()].some(s => s.name === name)) throw new Error(`LNK: duplicate section ${id}/${name}`);
        if (!alignment || (alignment & (alignment - 1))) throw new Error(`LNK: invalid alignment ${alignment}`);
        const kind = /^(?:\.bss|\.sbss)$/.test(name) ? "bss" : /^(?:\.text|\.init|\.fini)$/.test(name) ? "code" : "data";
        sections.set(id, { name, kind, size: 0, alignment, data: Buffer.alloc(0), address: 0, chunks: [], pointer: 0 }); break;
      }
      case 18: { const sid = r.u16(), offset = r.u32(), name = r.text(); if (!sections.has(sid)) throw new Error(`LNK: undefined local section ${sid}`); locals.push({ name, section: sections.get(sid)!.name, offset, size: 0, binding: "local" }); break; }
      case 28: r.u16(); files.push(r.text()); break;
      case 46: if (processor !== undefined) throw new Error("LNK: duplicate processor"); processor = r.u8(); if (![7, 9].includes(processor)) throw new Error(`LNK: unknown processor ${processor}`); break;
      case 50: r.take(2); break;
      case 52: r.take(3); break;
      case 54: r.take(4); break;
      case 56: r.take(6); break;
      case 58: r.take(8); break;
      case 60: if (r.u16() !== 0) throw new Error("LNK: nonzero END_SLD"); break;
      case 74: r.take(28); r.text(); break;
      case 76: case 78: case 80: r.take(10); break;
      case 82: r.take(14); r.text(); break;
      case 84: r.take(14); r.take(r.u16() * 2); r.text(); r.text(); break;
      case 86: r.take(36); r.text(); break;
      default: throw new Error(`LNK: unknown record ${opcode} at ${start}`);
    }
    records.push({ opcode, offset: start, bytes: bytes.subarray(start, r.pos) });
    if (ended) break;
  }
  if (!ended || r.pos !== bytes.length) throw new Error(ended ? `LNK: trailing bytes at ${r.pos}` : "LNK: missing END record");
  // Preserve every expression operation. Resolve record IDs to symbolic
  // identities (packaging IDs are not linker names), without folding even +0.
  const target = (e: Expression): string => {
    if (e.op === "symbol") { const s = symbols.get(e.id); if (!s) throw new Error(`LNK: undefined symbol ${e.id}`); return `${s.section === "UND" ? "import" : "named"}:${s.name}`; }
    if (e.op === "base") { const s = sections.get(e.id); if (!s) throw new Error(`LNK: undefined section ${e.id}`); return `${s.name}@0`; }
    if (e.op === "start" || e.op === "end") { const s = sections.get(e.id); if (!s) throw new Error(`LNK: undefined section ${e.id}`); return `${e.op}:${s.name}`; }
    if (e.op === "value") return `value:${e.value}`;
    if (e.op === "add" || e.op === "sub" || e.op === "div") return `expression:${JSON.stringify([e.op, target(e.left), target(e.right)])}`;
    throw new Error("LNK: unsupported relocation expression");
  };
  const relocations = patches.map(p => {
    const s = sections.get(p.section)!;
    if (s.kind === "bss" || p.offset + (p.kind === "REFHALF" ? 2 : 4) > s.size) throw new Error(`LNK: patch outside ${s.name}`);
    return { section: s.name, offset: p.offset, kind: p.kind, target: target(p.expression), expression: p.expression };
  });
  return { format: "psyq-lnk", sections: [...sections.values()].map(({ chunks, pointer, ...s }) => ({ ...s, data: Buffer.concat(chunks) })),
    symbols: [...symbols.values(), ...locals], relocations, files, ...(processor === undefined ? {} : { processor }), records };
}
