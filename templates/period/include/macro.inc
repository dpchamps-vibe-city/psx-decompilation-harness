/* Positional macros accepted by 1997 GNU as / ECOFF. */
#ifndef PSX_PERIOD_MACRO_INC
#define PSX_PERIOD_MACRO_INC
.macro glabel label
.globl \label
\label:
.endm
.macro alabel label
.globl \label
\label:
.endm
.macro dlabel label
.globl \label
\label:
.endm
.macro jlabel label
\label:
.endm
.macro ehlabel label
\label:
.endm
.macro endlabel label
.endm
.macro enddlabel label
.endm
.macro nonmatching label, size
.endm
#endif
