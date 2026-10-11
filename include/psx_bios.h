#ifndef PSX_BIOS_H
#define PSX_BIOS_H

/* Platform operation, not recovered SDK source. Currently supported selectors:
 * 0: Exception, 1: EnterCriticalSection, 2: ExitCriticalSection.
 * The BIOS consumes a0, produces v0 and may change memory. The register binding
 * belongs to this fixed operation only; callers must not write their own asm. */
#define PSX_BIOS_SYSCALL(selector) \
    ({ \
        register int __bios_result __asm__("$2"); \
        __asm__ volatile( \
            "addiu $4,$0,%1\n\t" \
            "syscall 0" \
            : "=r"(__bios_result) \
            : "i"(selector) \
            : "$4", "memory"); \
        __bios_result; \
    })

#endif
