#ifndef INCLUDE_ASM_H
#define INCLUDE_ASM_H
#if !defined(M2CTX) && !defined(PERMUTER)
#define INCLUDE_ASM(FOLDER, NAME) \
    __asm__(".text\n.set noat\n.set noreorder\n" \
            ".include \"" FOLDER "/" #NAME ".s\"\n" \
            ".set reorder\n.set at\n")
#define INCLUDE_RODATA(FOLDER, NAME) \
    __asm__(".rdata\n.include \"" FOLDER "/" #NAME ".s\"\n.text\n")
#else
#define INCLUDE_ASM(FOLDER, NAME)
#define INCLUDE_RODATA(FOLDER, NAME)
#endif
#endif
