/** Native DMPSX command finalization. Placeholder IDs/operand positions are
 * the PSY-Q INLINE_S/INLINE_C protocol; results use COP2 command encoding.
 * This is a closed period-tool stage, never a user-supplied rewrite hook. */
import { readRelocatableObject } from "../relocatableObject.js";
export const DMPSX_VERSION = 2;
const commands = new Map<number, { word: number; operands: number }>([
  [0x007f, { word: 0x4a180001, operands: 0 }], [0x00bf, { word: 0x4a280030, operands: 0 }],
  [0x0dff, { word: 0x4a680029, operands: 0 }], [0x0e3f, { word: 0x4a780010, operands: 0 }],
  [0x0e7f, { word: 0x4af8002a, operands: 0 }], [0x0ebf, { word: 0x4a980011, operands: 0 }],
  [0x0f7f, { word: 0x4ac8041e, operands: 0 }], [0x0fbf, { word: 0x4ad80420, operands: 0 }],
  [0x0fff, { word: 0x4ae80413, operands: 0 }], [0x103f, { word: 0x4af80416, operands: 0 }],
  [0x107f, { word: 0x4b08041b, operands: 0 }], [0x10bf, { word: 0x4b18043f, operands: 0 }],
  [0x10ff, { word: 0x4b280414, operands: 0 }], [0x113f, { word: 0x4b38041c, operands: 0 }],
  [0x117f, { word: 0x4b400006, operands: 0 }], [0x11bf, { word: 0x4b58002d, operands: 0 }],
  [0x11ff, { word: 0x4b68002e, operands: 0 }], [0x13bf, { word: 0x4a400012, operands: 0x03fc0000 }],
  [0x13ff, { word: 0x4aa00428, operands: 0x02000000 }], [0x143f, { word: 0x4b70000c, operands: 0x02000000 }],
  [0x147f, { word: 0x4b90003d, operands: 0x02000000 }], [0x14bf, { word: 0x4ba0003e, operands: 0x02000000 }],
]);
// INLINE_C.H placeholders joined by operation name to the Inline Programming
// Reference's DMPSX Inline Function Table. These fixed-field forms complement
// INLINE_S.H's parameterized commands above; no object bytes supply this table.
const cCommands = new Map<number, { word: number; operands: number }>([
  [0x0000007f, { word: 0x4a180001, operands: 0 }], /* gte_rtps: RTPS  */
  [0x000000bf, { word: 0x4a280030, operands: 0 }], /* gte_rtpt: RTPT  */
  [0x000000ff, { word: 0x4a480012, operands: 0 }], /* gte_rt: MVMVA 1,0,0,0,0 */
  [0x0000013f, { word: 0x4a486012, operands: 0 }], /* gte_rtv0: MVMVA 1,0,0,3,0 */
  [0x0000017f, { word: 0x4a48e012, operands: 0 }], /* gte_rtv1: MVMVA 1,0,1,3,0 */
  [0x000001bf, { word: 0x4a496012, operands: 0 }], /* gte_rtv2: MVMVA 1,0,2,3,0 */
  [0x000001ff, { word: 0x4a49e012, operands: 0 }], /* gte_rtir: MVMVA 1,0,3,3,0 */
  [0x0000023f, { word: 0x4a41e012, operands: 0 }], /* gte_rtir_sf0: MVMVA 0,0,3,3,0 */
  [0x0000027f, { word: 0x4a480012, operands: 0 }], /* gte_rtv0tr: MVMVA 1,0,0,0,0 */
  [0x000002bf, { word: 0x4a488012, operands: 0 }], /* gte_rtv1tr: MVMVA 1,0,1,0,0 */
  [0x000002ff, { word: 0x4a490012, operands: 0 }], /* gte_rtv2tr: MVMVA 1,0,2,0,0 */
  [0x0000033f, { word: 0x4a498012, operands: 0 }], /* gte_rtirtr: MVMVA 1,0,3,0,0 */
  [0x0000037f, { word: 0x4a482012, operands: 0 }], /* gte_rtv0bk: MVMVA 1,0,0,1,0 */
  [0x000003bf, { word: 0x4a48a012, operands: 0 }], /* gte_rtv1bk: MVMVA 1,0,1,1,0 */
  [0x000003ff, { word: 0x4a492012, operands: 0 }], /* gte_rtv2bk: MVMVA 1,0,2,1,0 */
  [0x0000043f, { word: 0x4a49a012, operands: 0 }], /* gte_rtirbk: MVMVA 1,0,3,1,0 */
  [0x0000057f, { word: 0x4a4a6412, operands: 0 }], /* gte_ll: MVMVA 1,1,0,3,1 */
  [0x000005bf, { word: 0x4a4a6012, operands: 0 }], /* gte_llv0: MVMVA 1,1,0,3,0 */
  [0x000005ff, { word: 0x4a4ae012, operands: 0 }], /* gte_llv1: MVMVA 1,1,1,3,0 */
  [0x0000063f, { word: 0x4a4b6012, operands: 0 }], /* gte_llv2: MVMVA 1,1,2,3,0 */
  [0x0000067f, { word: 0x4a4be012, operands: 0 }], /* gte_llir: MVMVA 1,1,3,3,0 */
  [0x000006bf, { word: 0x4a4a0012, operands: 0 }], /* gte_llv0tr: MVMVA 1,1,0,0,0 */
  [0x000006ff, { word: 0x4a4a8012, operands: 0 }], /* gte_llv1tr: MVMVA 1,1,1,0,0 */
  [0x0000073f, { word: 0x4a4b0012, operands: 0 }], /* gte_llv2tr: MVMVA 1,1,2,0,0 */
  [0x0000077f, { word: 0x4a4b8012, operands: 0 }], /* gte_llirtr: MVMVA 1,1,3,0,0 */
  [0x000007bf, { word: 0x4a4a2012, operands: 0 }], /* gte_llv0bk: MVMVA 1,1,0,1,0 */
  [0x000007ff, { word: 0x4a4aa012, operands: 0 }], /* gte_llv1bk: MVMVA 1,1,1,1,0 */
  [0x0000083f, { word: 0x4a4b2012, operands: 0 }], /* gte_llv2bk: MVMVA 1,1,2,1,0 */
  [0x0000087f, { word: 0x4a4ba012, operands: 0 }], /* gte_llirbk: MVMVA 1,1,3,1,0 */
  [0x000009bf, { word: 0x4a4da412, operands: 0 }], /* gte_lc: MVMVA 1,2,3,1,1 */
  [0x000009ff, { word: 0x4a4c6012, operands: 0 }], /* gte_lcv0: MVMVA 1,2,0,3,0 */
  [0x00000a3f, { word: 0x4a4ce012, operands: 0 }], /* gte_lcv1: MVMVA 1,2,1,3,0 */
  [0x00000a7f, { word: 0x4a4d6012, operands: 0 }], /* gte_lcv2: MVMVA 1,2,2,3,0 */
  [0x00000abf, { word: 0x4a4de012, operands: 0 }], /* gte_lcir: MVMVA 1,2,3,3,0 */
  [0x00000aff, { word: 0x4a4c0012, operands: 0 }], /* gte_lcv0tr: MVMVA 1,2,0,0,0 */
  [0x00000b3f, { word: 0x4a4c8012, operands: 0 }], /* gte_lcv1tr: MVMVA 1,2,1,0,0 */
  [0x00000b7f, { word: 0x4a4d0012, operands: 0 }], /* gte_lcv2tr: MVMVA 1,2,2,0,0 */
  [0x00000bbf, { word: 0x4a4d8012, operands: 0 }], /* gte_lcirtr: MVMVA 1,2,3,0,0 */
  [0x00000bff, { word: 0x4a4c2012, operands: 0 }], /* gte_lcv0bk: MVMVA 1,2,0,1,0 */
  [0x00000c3f, { word: 0x4a4ca012, operands: 0 }], /* gte_lcv1bk: MVMVA 1,2,1,1,0 */
  [0x00000c7f, { word: 0x4a4d2012, operands: 0 }], /* gte_lcv2bk: MVMVA 1,2,2,1,0 */
  [0x00000cbf, { word: 0x4a4da012, operands: 0 }], /* gte_lcirbk: MVMVA 1,2,3,1,0 */
  [0x00000dff, { word: 0x4a680029, operands: 0 }], /* gte_dpcl: DCPL  */
  [0x00000e3f, { word: 0x4a780010, operands: 0 }], /* gte_dpcs: DPCS  */
  [0x00000e7f, { word: 0x4af8002a, operands: 0 }], /* gte_dpct: DPCT  */
  [0x00000ebf, { word: 0x4a980011, operands: 0 }], /* gte_intpl: INTPL  */
  [0x00000eff, { word: 0x4aa80428, operands: 0 }], /* gte_sqr12: SQR 1 */
  [0x00000f3f, { word: 0x4aa00428, operands: 0 }], /* gte_sqr0: SQR 0 */
  [0x00000f7f, { word: 0x4ac8041e, operands: 0 }], /* gte_ncs: NCS  */
  [0x00000fbf, { word: 0x4ad80420, operands: 0 }], /* gte_nct: NCT  */
  [0x00000fff, { word: 0x4ae80413, operands: 0 }], /* gte_ncds: NCDS  */
  [0x0000103f, { word: 0x4af80416, operands: 0 }], /* gte_ncdt: NCDT  */
  [0x0000107f, { word: 0x4b08041b, operands: 0 }], /* gte_nccs: NCCS  */
  [0x000010bf, { word: 0x4b18043f, operands: 0 }], /* gte_ncct: NCCT  */
  [0x000010ff, { word: 0x4b280414, operands: 0 }], /* gte_cdp: CDP  */
  [0x0000113f, { word: 0x4b38041c, operands: 0 }], /* gte_cc: CC  */
  [0x0000117f, { word: 0x4b400006, operands: 0 }], /* gte_nclip: NCLIP  */
  [0x000011bf, { word: 0x4b58002d, operands: 0 }], /* gte_avsz3: AVSZ3  */
  [0x000011ff, { word: 0x4b68002e, operands: 0 }], /* gte_avsz4: AVSZ4  */
  [0x0000123f, { word: 0x4b78000c, operands: 0 }], /* gte_op12: OP 1 */
  [0x0000127f, { word: 0x4b70000c, operands: 0 }], /* gte_op0: OP 0 */
  [0x000012bf, { word: 0x4b98003d, operands: 0 }], /* gte_gpf12: GPF 1 */
  [0x000012ff, { word: 0x4b90003d, operands: 0 }], /* gte_gpf0: GPF 0 */
  [0x0000133f, { word: 0x4ba8003e, operands: 0 }], /* gte_gpl12: GPL 1 */
  [0x0000137f, { word: 0x4ba0003e, operands: 0 }], /* gte_gpl0: GPL 0 */
]);
/** Decode a real COP2 command into its SDK source operation. Used when a
 * disassembler renders a GTE command as a numeric word; unknown words are gaps,
 * never an encoding fallback. This does not modify any object. */
export const DMPSX_OPERATIONS = ["RTPS", "RTPT", "DCPL", "DPCS", "DPCT", "INTPL", "NCS", "NCT", "NCDS", "NCDT", "NCCS", "NCCT", "CDP", "CC", "NCLIP", "AVSZ3", "AVSZ4", "MVMVA", "SQR", "OP", "GPF", "GPL"] as const;
export function dmpsxSource(word: number): string | undefined {
  let i = 0;
  for (const [id, command] of commands) {
    const name = DMPSX_OPERATIONS[i++]!, mask = id === 0x13bf ? 0xfe400 : command.operands ? 0x80000 : 0;
    if (((word & ~mask) >>> 0) !== command.word) continue;
    if (!mask) return name;
    const sf = word >>> 19 & 1;
    return id === 0x13bf ? `${name}(${sf},${word >>> 17 & 3},${word >>> 15 & 3},${word >>> 13 & 3},${word >>> 10 & 1})` : `${name}(${sf})`;
  }
  return undefined;
}
export function dmpsxCommand(word: number): number | undefined {
  if ((word & 0xfc00003f) !== 0x3f) return undefined;
  const id = word & 0x3ffff, command = commands.get(id) ?? cCommands.get(id);
  if (!command || (word & ~(command.operands | 0x3ffff))) throw new Error(`psyq-dmpsx: unknown placeholder 0x${word.toString(16).padStart(8, "0")}`);
  const fields = ((word >>> 6) & 0x000fe000) | ((word >>> 8) & 0x400);
  return (command.word | fields) >>> 0;
}
/** Read-only check for INLINE_S.H's literal/left-shift/OR grammar.
 * No eval and no assembler-input rewrite; only an already-known placeholder
 * may survive an expanded-source numeric-word audit. */
export function isDmpsxPlaceholderExpression(source: string): boolean {
  const text = source.replace(/\s+/g, "");
  if (text.length > 512) return false;
  const tokens = text.match(/0x[\da-f]+|\d+|<<|[|()]/gi) ?? [];
  if (tokens.join("") !== text) return false;
  let at = 0;
  const priority: Record<string, number> = { "|": 1, "<<": 2 };
  const expression = (minimum = 0, depth = 0): bigint => {
    if (depth > 32) throw Error("deep expression");
    const token = tokens[at++]; let value: bigint;
    if (token === "(") { value = expression(0, depth + 1); if (tokens[at++] !== ")") throw Error("unclosed expression"); }
    else if (token && /^(?:0x[\da-f]+|\d+)$/i.test(token)) value = BigInt(token);
    else throw Error("nonconstant expression");
    while (at < tokens.length && priority[tokens[at]!] !== undefined && priority[tokens[at]!]! >= minimum) {
      const op = tokens[at++]!, right = expression(priority[op]! + 1, depth + 1);
      if (op === "<<" && (right < 0n || right > 31n)) throw Error("invalid shift");
      value = op === "|" ? value | right : value << right;
    }
    return value;
  };
  try { const word = Number(BigInt.asUintN(32, expression())); return at === tokens.length && dmpsxCommand(word) !== undefined; }
  catch { return false; }
}
export function finalizeDmpsx(input: Buffer) {
  const object = readRelocatableObject(input), output = Buffer.from(input);
  const replacements: Array<{ section: string; offset: number; placeholder: number; result: number }> = [];
  for (const [name, section] of object.sections) {
    if (!(section.flags & 4)) continue;
    if (section.size % 4) throw new Error(`psyq-dmpsx: unaligned executable section ${name}`);
    for (let offset = 0; offset < section.size; offset += 4) {
      const placeholder = section.data.readUInt32LE(offset), result = dmpsxCommand(placeholder);
      if (result === undefined) continue;
      if (object.relocations.some(r => r.section === name && r.offset < offset + 4 && r.offset + (r.type === 1 ? 2 : 4) > offset)) throw new Error(`psyq-dmpsx: relocated placeholder at ${name}+${offset}`);
      if (section.offset + offset + 4 > input.length) throw new Error("psyq-dmpsx: placeholder outside file");
      output.writeUInt32LE(result, section.offset + offset);
      replacements.push({ section: name, offset, placeholder, result });
    }
  }
  return { output, replacements };
}
