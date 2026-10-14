# Evidence-backed operation macros

Agents may create shared macros when strong evidence supports them. **No
per-macro human approval, approval field or allowlist change is required.** Put
project definitions in `include/*.h`, include that header explicitly, and keep
the definition and its evidence together in any authorized commit. The ordinary
repository rule about when to commit still applies.

Inspectable C helpers need no evidence manifest. Existing SDK macros and
standing platform operations retain their established checks. This gate is for
new operation definitions that need otherwise forbidden assembly, register
bindings or opaque control syntax. It is not permission to hide a complete
function, an assembly stub, an allocator workaround or a compiler-flag change.

## Positive evidence, not frustration

First identify the semantic operation and its operands in the original code.
Read the configured SDK/reference headers and search for an existing operation
before creating another. Use the original words, not just unexpanded compiler
assembly. A recognisable ABI transfer, coprocessor instruction or architectural
operation is positive evidence; a stubborn residual, a high match percentage or
an exhausted spelling search is not.

The automatic gate accepts either:

- the same parameter/body token binding as a macro in the project's configured
  immutable SDK headers, plus one direct, production-byte-exact use; or
- two independent original-code uses, each production-byte-exact, each with a
  supported hardware/ABI instruction class also present in the definition,
  and each material under a compiled counterfactual.

Original-code independence uses owner and code coordinates, not names: aliases
at the same location do not count twice. Current non-SDK classes are loaded
entry transfers (`lui/lw/nop/jr/nop` with consistent registers), COP0, COP2,
`syscall`, `break`, and trapping `addi`. Ordinary scalar register allocation
is deliberately not a class. New classes need original-word evidence and
regression tests in the shared verifier, not a permission bit.

The counterfactual replaces only direct invocations in the named witness
function with argument evaluation and zero. It recompiles the complete owning
translation unit under unchanged production configuration. A compiled non-match
shows a material use; a matching result, missing result or compilation error
cannot establish one. A live neighboring function cannot rescue a dead use.
For libraries, the positive oracle still compares the entire relocatable
member, including sections, symbols and symbolic relocations. Exact bytes
establish reproducibility, **not the historical spelling of the source**.

## Define and measure

1. Name a thin semantic operation. Document its ABI, operands, effects and
   original-code witnesses beside the shared definition. Preserve prototypes,
   argument/return behavior and observable effects. Statement operations can use
   `do { ... } while (0)`; it is a single-statement wrapper, not a runtime loop.
2. Put it in a project-owned `include/*.h` file. Do not edit reference SDK
   headers, put local copies in `.c` files, emit whole functions through asm,
   add `INCLUDE_ASM`, or change production tools/flags to make it match.
3. Measure its real users through the production byte oracle. Add the evidence
   record and obtain the exact definition fingerprint:

   ```sh
   # Installed-package project (run from the project root):
   node tools/harness-proxy.mjs tools/diagnostics/macroEvidence.ts --fingerprint include/operations.h
   node tools/harness-proxy.mjs tools/diagnostics/macroEvidence.ts --json

   # Cloned harness layout:
   npm run macro-evidence -- --fingerprint include/operations.h
   npm run macro-evidence -- --json
   ```

4. Run `psx_source_policy`, each affected function's byte oracle, and
   `npm run check-all` before claiming completion. A shared-header edit must not
   break other users. Match, policy and scope checks are separate requirements.

Create `configs/macro-evidence.json` with this shape (replace the example names,
keys and fingerprint with measured project data):

```json
{
  "version": 1,
  "macros": [{
    "name": "LOADED_ENTRY_TRANSFER",
    "header": "include/operations.h",
    "definitionSha256": "<SHA-256 printed by --fingerprint>",
    "operation": "Transfer to an entry loaded from a pointer slot",
    "rationale": "Two original ABI veneers preserve ra and jump through the loaded entry",
    "witnesses": ["member::first", "member::second"]
  }]
}
```

For the SDK route, add `"sdk": { "header": "include/psyq/reference.h",
"macro": "SDK_OPERATION" }`; one measured witness suffices. The header must be
inside a configured immutable SDK-header root. Token comparison ignores comments
and code whitespace, but does not normalize string contents or rename operands.

## What the gate enforces

The evidence file is not a grant by itself. Every source-policy audit checks
safe include-file paths, the active fixed-arity definition and its SHA-256, the
original words, fresh production comparisons, direct active invocations and
material-use results. Changed definitions require remeasurement and a new
fingerprint. Successful evidence exempts only that definition in that header;
other code in the header remains audited. Duplicate definitions, `#undef` and
wrong-arity calls fail. Whole-function asm directives and assembly stubs fail
regardless of byte identity. Legacy canonical BIOS enable flags remain supported;
evidence-bound BIOS calls do not need a new approval flag.

Macro bodies that fail the C parser are no longer silently skipped. Opaque
assembly/control bodies fail closed without evidence. Uninspectable token-paste
bodies can also require evidence; write an inspectable C helper instead when
there is no architectural operation to justify an exception. Comments, quoted
mentions and disabled code do not create evidence.

If evidence is insufficient, preserve the candidate and state the missing proof.
Do not infer that clean C must exist, or that it cannot exist, merely from a
failed search. A witnessed unsupported target class is a classification to
report to the controller, not an invitation to ask for per-macro approval.
