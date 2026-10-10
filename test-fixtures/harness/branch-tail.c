#include "common.h"

typedef struct { s32 x, y, z, pad; } FixturePosition;
extern u8 fixture_storage[];

/* Borrowed arithmetic/control shape, with independent names, declarations and
 * synthetic address geometry. No original game image or published context. */
s32 ovl_fixture_branch(FixturePosition *pos, u16 *colOut, u16 *rowOut) {
    FixturePosition copy;
    u8 *base;
    u8 *p;
    u8 *table;
    s32 *cell;
    s32 index;
    s16 x;
    s16 z;
    s16 col;
    s16 row;

    copy = *pos;
    *colOut = pos->x + 0x654;
    *rowOut = 0x4C4 - pos->z;
    z = *rowOut;
    x = *colOut;
    *colOut = (s16)*colOut / 400;
    *rowOut = (s16)*rowOut / 400;
    if (x < 0) {
        *colOut -= 1;
        return 2;
    }
    col = *colOut;
    if (col >= 7) return 3;
    if (z < 0) {
        *rowOut -= 1;
        return 2;
    }
    row = *rowOut;
    if (row >= 7) return 3;
    base = fixture_storage;
    index = (row * 45 + col) * 4;
    p = base + 0x20000;
    table = p + 0x3608;
    cell = *(s32 **)(table + index);
    if (*(s16 *)(p + 0x5476) == 6) {
        if ((*cell & 8) == 0) {
            return 1;
        }
    } else {
        return 0;
    }
    return 0;
}
