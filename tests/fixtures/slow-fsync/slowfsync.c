// A slow disk for tests (tests/plugins_db_wal.test.js): loaded with LD_PRELOAD
// into a child node process, every fsync / fdatasync waits FAKE_FSYNC_MS
// before it syncs, and the number of syncs is written to FAKE_FSYNC_REPORT
// when the process ends. SQLite (better-sqlite3) and Node's fs call these two.
//
//   cc -shared -fPIC -O2 -o slowfsync.so slowfsync.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static atomic_long syncs;
static long delay_ms = -1;

static void slow(void) {
  if (delay_ms < 0) {
    const char *s = getenv("FAKE_FSYNC_MS");
    delay_ms = s ? atol(s) : 0;
  }
  atomic_fetch_add(&syncs, 1);
  if (delay_ms > 0) {
    struct timespec t = { delay_ms / 1000, (delay_ms % 1000) * 1000000L };
    nanosleep(&t, NULL);
  }
}

int fsync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
  slow();
  return real(fd);
}

int fdatasync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
  slow();
  return real(fd);
}

__attribute__((destructor)) static void report(void) {
  const char *f = getenv("FAKE_FSYNC_REPORT");
  if (!f) return;
  FILE *o = fopen(f, "w");
  if (!o) return;
  fprintf(o, "%ld\n", (long)syncs);
  fclose(o);
}
