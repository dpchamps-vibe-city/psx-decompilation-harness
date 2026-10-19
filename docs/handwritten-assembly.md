# Handwritten-assembly heuristics

The scanner ranks **original MIPS-I words**, not failed C attempts. It supports
linked EXE/overlay functions and ELF/ar library members, including directory TUs.
It compiles nothing and changes no sources, flags, policy, prompts or progress.

## Running it

In a configured harness checkout:

```sh
npm run scan-handwritten -- --output build/handwrittenAssembly/report.json
npm run scan-handwritten -- --function 'MEMBER_ID::SYMBOL'
npm run scan-handwritten -- --container MEMBER_ID --threshold 90 --json
```

An installed-package project uses the package's script host with explicit project
context, just like the other internal CLIs:

```sh
node --import /ABS/HARNESS/node_modules/tsx/dist/loader.mjs \
  /ABS/HARNESS/tools/lib/scriptHost.ts \
  tools/diagnostics/handwrittenAssembly.ts --project /ABS/PROJECT \
  --output build/handwrittenAssembly/report.json
```

If the project already provides `tools/harness-proxy.mjs`, the equivalent is:

```sh
node tools/harness-proxy.mjs tools/diagnostics/handwrittenAssembly.ts \
  --function 'MEMBER_ID::SYMBOL'
```

`--function` and `--container` are repeatable. Unqualified library symbols must
resolve uniquely. `--all` and `--limit N` affect text display only; JSON retains
every selected function. The default display floor is 40. `--output` is optional
and accepts only a JSON destination inside project `build/`, without symlinks.
Direct CLI `--help` needs no configured project or assets.

## Evidence and scoring

Scores are **heuristic support on a 0–100 scale, not probabilities**. High is
80–100, medium 40–79, and low 0–39. Missing usable analysis can be undetermined.
The default candidate threshold is 80; `--threshold 1..100` changes eligibility,
not evidence or the confidence bands.

| Signal | Weight | Structural? |
| --- | ---: | --- |
| Entry `$ra` saved outside the stack, same-slot reload used to return after calls, no reachable `$sp` writes | +65 | yes |
| Context save/restore of at least six `$s` registers plus `$sp` and `$ra` through a non-stack context base | +85 | yes |
| Exception return through a kernel/EPC register, with `rfe` in the delay slot | +75 | yes |
| Explicit `$k0`/`$k1` GPR use | +25 | no |
| Trapping `addi`/`add`/`sub` encodings | +20 | no |
| BIOS transfer through `$t2` with constant vector and `$t1` selector | +10 | no |
| COP0/exception operations | +10 | no |
| Exactly referenced embedded kernel-context fragment forwarded by a bounded word-copy loop | +20 | no |
| Same-owner executable-buffer save / call-trampoline install / saved-prefix restore lifecycle | +20 | no |
| Copied transfer template resolving to a traced local entry or an independently witnessed RAM deployment | +20 | no |
| Entry `$ra` capture without the complete return-state pattern | +5 | no |
| At least three transfer delay slots, all `nop` | +3 | no |
| Conventional stack allocation and stack `$ra` save | −15 | no |

Each signal contributes once, regardless of repetition. **All code-patching
signals together contribute at most +20**: alternative observations of code
manipulation are not independent origin evidence. Individual observations remain
visible in the report, even when the family cap applies. Scores without a
structural signal, or with incomplete control/register analysis, are capped
below high. Nomination also requires a structural signal and complete analysis,
even if a lower threshold is requested. BIOS veneers, GTE macros, syscall wrappers,
divide guards and diagnostic `$ra` hooks alone are not sufficient.

The analysis follows reachable control flow, assigns delay slots to transfer
edges, installs a call's link before its slot and clobbers volatile GPRs after
it. A BIOS selector may be set in the slot; the jump target is still read before
that slot. Stack aliases are distinguished from global/context storage. ELF
address identity includes symbolic references and paired HI16/LO16 addends;
equal low halves are not assumed to mean the same object. COP register numbers
are never mistaken for GPR numbers.

Unreachable padding/data contributes no opcode evidence merely by being present.
Scanner version 2 also recognizes a narrow **copied-payload** relation: a
single-entry loop with exact local source/limit addresses copies 1–64 words,
steps both pointers by four and forwards its one load unchanged to its one
store, respecting MIPS-I load spacing. The source must be wholly within the
function and outside its directly reachable instructions. A score bonus requires
an unrelocated, decoded fragment of kernel-based context stores (including
`$ra`, at distinct aligned offsets) and a COP0 EPC read. Ordinary data, zeros,
GTE commands alone, or merely taking the address of instruction-shaped bytes do
not qualify. This signal is supporting-only: C can also copy code bytes.

JSON `embeddedCopies` records source ranges, copy-loop sites, iteration counts
and decoded payload words. Payload evidence carries `role: copied-payload` and
is **not** counted as direct execution or used to inflate other opcode signals.

Since scanner version 3, same-owner witnesses can also establish a narrow code-hook
lifecycle across functions. The original words must show all of:

- A bounded copy of 12 or 16 bytes from a cached pointer into a zero-initialized
  buffer within known executable code bounds. The pointer must come from shared
  symbolic/absolute storage: equal stack or argument offsets across functions
  do not establish shared storage.
- In that installer, a subsequent copy to the same cached pointer of a resolved
  four-word `lui` / `addiu` / `jalr` / `nop` trampoline. Its target must be an
  independently bounded local entry. The save must dominate the install, not
  merely precede it in the listing.
- In a different function, a matching copy from the same buffer back through the
  same cached pointer, with the exact saved extent.

For a 12-byte restore, the fourth installed word is the trampoline's nop slot;
the report does not pretend all 16 bytes were restored. Word-copy bounds can use
either the source or destination pointer, and both step by four. ELF address
identity uses normalized full section addends. Loaded-pointer values and offsets
are distinct from the addresses of the storage slots they came from.

`codeHooks` records all three copy sites, the separate byte counts, buffer and
trampoline coordinates, resolved target, and original-word/relocation hashes of
the witnesses. A selected-function query still examines its owner's companions
for evidence, without claiming those companions were selected. Witnesses cannot
cross library members or image containers. Only the actual installer/restorer
receives the supporting signal: neighboring helpers, buffers and callees do not
inherit origin scores. C can implement code hooks too, so this does not replace
the independent calling-convention evidence or the existing-C protection.

Since scanner version 4, a bounded copy can also witness a **control-transfer
template**, without a save/restore lifecycle. This recognizes an exactly
addressed `lui R` / `addiu R,R` / `jr R` or `jalr R` prefix, followed by a source
`nop` slot and optional copied nop padding. The target must resolve through
full address/relocation data to either:

- A unique same-owner code extent, including an **interior entry** explicitly
  addressed by the template. Tracing starts at that entry, stays within the
  recorded extent and requires supported control flow and a return/exception
  return. It does not treat arbitrary unreachable bytes as entry points.
- An entry inside another independently bounded word-copy deployment to PSX
  RAM. Only the physical 2 MiB RAM window and its KSEG0/KSEG1 aliases are
  normalized. The source extent must be uniquely identified, decoded and
  contain control flow; conflicting deployments, MMIO/KSEG2 addresses and
  out-of-range or unaligned entries fail closed. This proves the bytes are
  targeted as deployed code, **not** that the deployed handler was completely
  traced or that a particular runtime call order occurred.

A 12-byte prefix copies **only three words**. The following source nop helps
identify the template, but the destination delay slot remains unknown. The
report never upgrades that to a four-word install. `copiedTransfers` records
template words and coordinates, exact copied size, whether the slot is copied,
local-entry trace facts or the independent RAM deployment, and witness hashes.
Only the copying function receives supporting points. A neighboring function
whose inferred extent contains a template/handler retains its normal-entry
score; it does not inherit the interior handler's privileged instructions.
Existing C protection and the independent structural-signal requirement apply
unchanged. In images, witnesses are also scoped to the configured owning TU,
not just the container.

## Report and boundaries

JSON records original-word and relocation hashes, image/section coordinates,
evidence offsets and words, analysis limitations, configured toolchain identity,
source status, and original module ownership. The compiler is recorded as
**configured**, not identified from these bytes. No compiler-impossibility claim
is made. A function name, disassembly comment, C spelling or low match percentage
cannot increase the score.

Existing C definitions and assembly sources are protected. Malformed/conditional
or otherwise unresolved source ownership is protected too. Source status affects
eligibility, never the evidence score; protection does not claim a fresh byte
match. Unknown instructions, unresolved indirect dispatch and missing/invalid
bounds remain explicit limitations. Symbol sizes inferred from neighboring
symbols are advisory bounds, not proof of historical function boundaries.
Embedded handlers outside the supported exact word-copy/template/lifecycle patterns can
still be missed (for example, indirect installation, external arrays or complex
loops). Inferred symbol boundaries can also split handler continuations and
runtime-filled code slots; an incomplete per-entry analysis is not evidence of C.
This is a conservative heuristic, not a complete disassembler or origin proof.

Module suggestions preserve library member/TU boundaries. An image container is
not treated as one TU. A whole-library-module candidate requires all its scanned
functions to qualify and no missing function census; mixed C/assembly members
are not nominated for wholesale replacement.

**This command emits no `.s` files and grants no source-policy exception.**
A later assembly-emission/build stage must preserve existing C, symbols, data,
relocations and member ownership, then verify whole outputs with the production
byte oracle. The heuristic score alone does not establish an exact conversion.
Shared C operation macros remain a separate [evidence-backed mechanism](macro-evidence.md).

## Retaining classified handwritten assembly

Classification and extraction are separate. A heuristic nomination does not
prove handwritten origin, and a successful round trip does not recover the
original author's source. Settle the classification from independent original
word/ABI or original-object evidence; do not demote real C because matching is
hard. Members already represented as assembly TUs stay out of the C loop.

For an explicitly classified native assembly backlog, retain the existing
assembler-ready extraction **without changing a byte**. `split` does this itself
for every assembly-origin member (one whose native LNK object numbers its symbols
from 1, without the compiler's two labels), so a new SDK reaches the retained form
from `split` alone. The command remains for previews and repairs:

```sh
npm run library -- retain-handwritten                 # preview
npm run library -- retain-handwritten --write          # copy existing extraction
npm run check-all
```

The TU form follows the native object's origin. `split` fails closed on an
assembly TU whose original GCC compiled (symbol IDs from 3) and names the
remedy: `npm run library -- reform [--member ID ...] [--write]` turns such an
unedited assembly TU back into the C TU split would have written, records its
hand-written functions as retained parts, verifies the member, and rolls back on
any failure. A hand-written function inside a C member (an `asm()` body in the
original C file) is a retained part of that C TU; see
[library-targets](library-targets.md).

The command does not classify new functions, translate instructions, rename
labels, change delay slots or adjust the toolchain. It accepts only existing
assembly-backlog TUs with native originals and fresh preprocessing receipts.
Existing C and non-backlog assembly are untouched. Conflicting destination
files cause refusal rather than overwrite.

Each member then contains:

```text
handwritten.ASM          verbatim mechanical assembly input, before CPP
handwritten-symbols.ASM  verbatim mechanical symbol declarations, before CPP
tu.json                  handwritten provenance, original hash and file hashes
```

The two `.ASM` files are copied as bytes from the established extraction's
preprocessor inputs. They are not renamed preprocessed dumps, hand-edited, or
converted into plausible original source. A generated CPP driver under `build/`
includes the declarations before the member input; production CPP emits `.s`
under `build/`, then the unchanged assembler/stages build the object. No generated
`.s` copy is retained in source. Existing preserved assembly sources are untouched.
A repeated retention is a no-op; ordinary `split` preserves the retained form.

The manifest's `handwritten.kind: "original-extraction"` and
`format: "assembler-with-cpp"` explicitly distinguish
this representation from recovered author source. Both retained file hashes
and the original-object hash are checked. Source-policy handling is limited to
those exact hash-bound extraction files, not an exemption for arbitrary assembly
or raw instruction encodings. Every ordinary source check remains in force.

The manifest retains `backlog: true` as the machine-extraction status: it must
not be counted as reconstructed C or as recovered assembler source. Graph
entries remain `handwritten: "asm"` and additionally carry
`retainedHandwrittenAssembly: true`. These functions are not C translation
work. Existing disabled attempts are preserved verbatim, uncompiled.

Never rewrite assembly to make a round trip pass, try alternative source forms,
change an assembler or its flags to fit a member, or rename labels for a match.
A failed extraction/build is a tooling defect or an unresolved case to report,
not permission to reconstruct assembly. Annotations and research belong in
separate notes; retained extraction files remain unchanged.
