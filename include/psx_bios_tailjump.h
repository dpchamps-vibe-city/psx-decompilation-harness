#ifndef PSX_BIOS_TAILJUMP_H
#define PSX_BIOS_TAILJUMP_H

/* Platform BIOS transfer, not recovered SDK source. Reserve the service
 * register in this wrapper TU so the compiler retains its assignment and can
 * place it in the jump delay slot. No ordinary call: arguments and ra pass
 * through to the BIOS. This header is for BIOS-wrapper translation units. */
register unsigned long __psx_bios_selector __asm__("$9");

#define PSX_BIOS_TAILJUMP(vector, selector) \
    do { \
        register void *__psx_bios_entry __asm__("$10") = (void *)(vector); \
        __psx_bios_selector = (selector); \
        goto *__psx_bios_entry; \
    } while (0)

/* Loaded-entry transfer: $9 holds the address, not a service selector. */
#define PSX_BIOS_TAILJUMP_LOAD(destination) \
    do { \
        register void *__psx_bios_entry __asm__("$9") = (destination); \
        goto *__psx_bios_entry; \
    } while (0)

/* Public definition: expose the SDK signature and service binding together
 * with the terminal transfer. */
#define PSX_BIOS_FUNCTION(result, name, parameters, vector, selector) \
    result name parameters { \
        PSX_BIOS_TAILJUMP(vector, selector); \
    }

#endif
