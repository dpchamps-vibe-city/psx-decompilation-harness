/** Native object contents, not a link-equivalence normalization. In-place
 * addends retain the producer's section-layout convention, byte for byte. */
export type RelocationKind = "REFHALF" | "REFWORD" | "JMPADDR" | "REFHI" | "REFLO" | "GPREL" | "LITERAL";
/** Binary left/right are semantic operands; the LNK wire grammar writes right first. */
export type Expression = { op: "value"; value: number } | { op: "symbol" | "base" | "start" | "end"; id: number } |
  { op: "add" | "sub" | "div"; left: Expression; right: Expression };
export interface NativeSection {
  name: string; kind: "code" | "data" | "bss"; size: number; data: Buffer;
  /** Encoded section constraint, or null when the format does not encode it.
   * A reader's in-memory default is not an object-file declaration. */
  alignment: number | null;
  /** File position is used only by declared stages writing candidate objects. */
  fileOffset?: number; address: number;
}
export interface NativeSymbol {
  name: string; section: string; offset: number; size: number; binding: "external" | "local";
  /** Wire identity; ECOFF nil entries consume IDs even though they emit no symbol. */
  id?: number; storageClass?: number; symbolType?: number;
}
export interface NativeRelocation { section: string; offset: number; kind: RelocationKind; target: string; expression?: Expression; symbolId?: number }
export interface NativeObject {
  format: "psyq-lnk" | "ecoff"; sections: NativeSection[]; symbols: NativeSymbol[]; relocations: NativeRelocation[];
  files: string[]; processor?: number;
  /** Encoded ECOFF input gp value, when an optional header supplies it. */
  gpValue?: number;
  /** Format-specific record evidence; debug records are retained, not guessed. */
  records?: Array<{ opcode: number; offset: number; bytes: Buffer }>;
}
export class ObjectCursor {
  pos = 0;
  constructor(readonly bytes: Buffer, readonly format: string) {}
  need(n: number) { if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length) throw new Error(`${this.format}: truncated record at ${this.pos} (need ${n})`); }
  take(n: number) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  u8() { return this.take(1)[0]!; }
  u16() { return this.take(2).readUInt16LE(); }
  u32() { return this.take(4).readUInt32LE(); }
  text() { const b = this.take(this.u8()); if (b.includes(0)) throw new Error(`${this.format}: NUL in name`); return b.toString("latin1"); }
}
