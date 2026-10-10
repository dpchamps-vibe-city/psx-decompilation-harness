# Project scaffolding

No active game is configured here. `project-info.json` contains only conventional
header roles; it is not a measured target profile. `flag_overrides.mk` is empty.
`project.mk.example` illustrates main target/basename overrides for GNU make.

Before using a game workflow, supply independently generated/validated splat,
symbol, section-layout, SDK, and container facts. The Makefile include is only a
path seam: inherited tool readers do not yet consistently resolve it or alternate
project roots. See `../docs/game-agnosticity.md`.

Original BTN configs were retained in `../examples/btn-decompilation/configs/`,
not imported as active facts. Do not copy their profiles, addresses, flag
exceptions, or acknowledgements into a different target's configuration.
