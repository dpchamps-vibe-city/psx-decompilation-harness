/** LNK v2 wire writer. The conversion stage owns the closed layout/ABI rules. */
import type { Expression } from "./model.js";
export class LnkWriter {
  private chunks: Buffer[] = [Buffer.from("LNK\x02", "latin1")];
  u8(n: number) { this.chunks.push(Buffer.from([n])); return this; }
  u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); this.chunks.push(b); return this; }
  u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); this.chunks.push(b); return this; }
  text(s: string) {
    const b = Buffer.from(s, "latin1");
    if (b.length > 255 || b.includes(0) || b.toString("latin1") !== s) throw new Error("LNK: invalid name");
    this.u8(b.length); this.chunks.push(b); return this;
  }
  bytes(b: Buffer) { this.u8(2).u16(b.length); this.chunks.push(b); return this; }
  expression(e: Expression): this {
    if (e.op === "value") return this.u8(0).u32(e.value);
    if ("id" in e)
      return this.u8({ symbol: 2, base: 4, start: 12, end: 22 }[e.op]).u16(e.id);
    // Prefix expressions serialize right before left.
    return this.u8({ add: 44, sub: 46, div: 50 }[e.op]).expression(e.right).expression(e.left);
  }
  finish() { return Buffer.concat(this.chunks); }
}
