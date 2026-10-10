#include "common.h"
extern u8 fixture_storage[];

/* Borrowed short-circuit producer shape, independent of game context. Keeping
 * the typed halfword reads and address-expression family is intentional. */
typedef struct {
    s32 unk0;
    s32 unk4;
    s32 unk8;
    s32 unkC;
} FixtureCopy;

s32 ovl_fixture_branch(s32 *arg0, u16 *arg1, u16 *arg2, void *arg3) {
    FixtureCopy tmp;
    u8 *base;
    u8 *p;
    s16 temp_a1;
    s16 temp_a3;
    s16 temp_a0;
    s16 temp_v1;
    s32 *ptr;

    tmp = *(FixtureCopy *)arg0;
    *arg1 = *(u16 *)arg0 + 0x654;
    *arg2 = 0x4C4 - *(u16 *)((u8 *)arg0 + 8);
    temp_a0 = (s16)*arg2;
    temp_a1 = (s16)*arg1;
    *arg1 = (s16)*arg1 / 400;
    *arg2 = (s16)*arg2 / 400;
    if (temp_a1 < 0) {
        *arg1 -= 1;
        return 2;
    }
    temp_a3 = (s16)*arg1;
    if (temp_a3 >= 7) {
        return 3;
    }
    if (temp_a0 < 0) {
        *arg2 -= 1;
        return 2;
    }
    temp_v1 = (s16)*arg2;
    if (temp_v1 >= 7) {
        return 3;
    }
    base = (u8 *)fixture_storage;
    p = base + 0x20000;
    ptr = *(s32 **)(p + 0x3608 + (temp_v1 * 0x2D + temp_a3) * 4);
    if (*(s16 *)(p + 0x5476) != 6 || (*ptr & 8) != 0) {
        return 0;
    }
    return 1;
}
