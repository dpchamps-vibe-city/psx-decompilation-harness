/** Diagnostic view only. Does not modify an object or its encoded addends. */
import type { RelocatableObject } from "../relocatableObject.js";
import type { NativeObject, RelocationKind } from "./model.js";
import { nativeRelocationOperands } from "./relocations.js";
const types: Record<RelocationKind, number> = { REFHALF: 1, REFWORD: 2, JMPADDR: 4, REFHI: 5, REFLO: 6, GPREL: 7, LITERAL: 8 };
export function nativeObjectView(native: NativeObject): RelocatableObject {
  const operands = nativeRelocationOperands(native);
  // This is a diagnostic ELF-shaped adapter, never acceptance evidence. Zero
  // represents unavailable alignment here; native retains the explicit null.
  return { native, flags: 0, sections: new Map(native.sections.map((s, i) => [s.name, { index: i + 1, type: s.kind === "bss" ? 8 : 1, flags: 2 | (s.kind === "code" ? 4 : s.name === ".rdata" ? 0 : 1), alignment: s.alignment ?? 0, offset: s.fileOffset ?? 0, address: s.address, size: s.size, link: 0, info: 0, entsize: 0, data: s.data }])),
    symbols: native.symbols.map(s => ({ name: s.name, value: s.offset, size: s.size, binding: s.binding === "external" ? 1 : 0, type: s.symbolType === 6 || s.symbolType === 14 ? 2 : 0, visibility: 0, section: s.section })),
    relocations: native.relocations.map((r, i) => {
      const value = operands[i]!;
      return { section: r.section, offset: r.offset, type: types[r.kind],
        reference: "unresolved" in value ? r.target : value.reference ?? "ABS@0",
        addend: "unresolved" in value ? null : value.addend };
    }) };
}
