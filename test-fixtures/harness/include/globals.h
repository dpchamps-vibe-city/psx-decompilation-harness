#ifndef FIXTURE_GLOBALS_H
#define FIXTURE_GLOBALS_H

/* Declaration shapes used by the base-pointer search; no game layout. */
typedef int s32;
extern s32 fixture_values[32];
extern s32 fixture_result;
extern unsigned char fixture_run_storage[32];
#define fixture_run (*((s32 *)fixture_run_storage))
s32 fixture_observe(s32 value);
s32 fixture_combine(s32, s32, s32, s32, s32);

#endif
