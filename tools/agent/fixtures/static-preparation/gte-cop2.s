.set noat
.set noreorder
glabel gte_flow
    lbu $t4, 0($a0)
    lbu $t5, 1($a0)
    ctc2 $t4, $13
    ctc2 $t5, $14
    lwc2 $0, 0x28($a0)
    cfc2 $v1, $27
    mvmva 1, 0, 3, 3, 0
    rtpt
    mfc2 $v0, $25
    addu $v0, $v0, $v1
    jr $ra
    swc2 $14, 0x10($a1)
