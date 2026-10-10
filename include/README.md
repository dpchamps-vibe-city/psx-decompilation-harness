# Platform headers and empty project roles

The root retains the inherited PSY-Q header set and PSX assembly/platform support
headers. This is one supported SDK/toolchain profile, not a universal choice for
all games. `common.h` contains scalar types and supported macros only;
`globals.h`, `globals_override.h`, and `game_types.h` are empty bootstrap roles.
`functions.h` must be generated from the active project's declarations.

There are no BTN structs or data symbols in the active common/global scaffolds.
The complete original header tree is retained under
`../examples/btn-decompilation/include/`.

Some retained debug/scratchpad comments and entry-register macros originated in
BTN. They are not blanket policy authorization for another project. Header role,
SDK profile, and project-specific source-policy integration still need the work
listed in `../docs/game-agnosticity.md`.
