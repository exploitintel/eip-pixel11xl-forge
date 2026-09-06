/* privns: run a command in a private mount namespace with an overlay on /system/etc.
   usage: privns UPPER WORK CMD [ARGS...] */
#define _GNU_SOURCE
#include <sched.h>
#include <sys/mount.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: privns UPPER WORK CMD [ARGS...]\n"); return 2; }
    if (unshare(CLONE_NEWNS)) { perror("unshare"); return 1; }
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) { perror("make-rprivate"); return 1; }
    char opts[1024];
    snprintf(opts, sizeof opts, "lowerdir=/system/etc,upperdir=%s,workdir=%s", argv[1], argv[2]);
    if (mount("overlay", "/system/etc", "overlay", 0, opts)) { perror("overlay /system/etc"); return 1; }
    execv(argv[3], &argv[3]);
    perror("exec"); return 1;
}
