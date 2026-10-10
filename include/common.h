#ifndef COMMON_H
#define COMMON_H

#include "include_asm.h"

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef signed char s8;
typedef signed short s16;
typedef signed int s32;
typedef volatile unsigned char vu8;
typedef volatile unsigned short vu16;
typedef volatile unsigned int vu32;
typedef volatile signed char vs8;
typedef volatile signed short vs16;
typedef volatile signed int vs32;

/* MIPS break encoding expected by maspsx. */
#define BREAK(n) __asm__ volatile("break %0" :: "n"((n) * 1024))
#define M2C_BREAK(n) BREAK(n)

/* Supported entry-value representation, NOT a blanket policy exception.
 * Use only with independent target-byte evidence and project authorization.
 * The migration must still generalize its census/policy integration. */
#define CAPTURE_PREV_RET(name) register s32 name asm("$2")

#include "globals.h"

#endif
