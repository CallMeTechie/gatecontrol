// A slow disk for tests (tests/plugins_db_wal.test.js): loaded with LD_PRELOAD
// into a child node process, every fsync / fdatasync waits FAKE_FSYNC_MS
// before it syncs, and the number of syncs is written to FAKE_FSYNC_REPORT
// when the process ends. SQLite (better-sqlite3) and Node's fs call these two.
// FAKE_FSYNC_NOSYNC=1: an instant disk — the real sync is left out, so the
// result does not depend on the disk of the machine the test runs on.
// FAKE_FSYNC_LOG: every sync, written to this file when the process ends, one
// line each: "<begin ns> <end ns> <path>" on CLOCK_MONOTONIC — the clock of
// process.hrtime() in Node — so a test can tell whether a sync lay inside a
// statement, whatever the machine took for it (a duration in ms measures the
// machine as well: 335 ms for a one-row write on a busy CI runner, 22. 11.).
//
//   cc -shared -fPIC -O2 -o slowfsync.so slowfsync.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

static atomic_long syncs;
static long delay_ms = -1;
static int nosync = -1;

#define LOG_MAX 4096
#define PATH_MAX_LOG 160
static struct { long long from, to; char path[PATH_MAX_LOG]; } log_[LOG_MAX];
static atomic_long logged;

static long long now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)t.tv_sec * 1000000000LL + t.tv_nsec;
}

/** → the slot of this sync in the log (or -1: full); its begin and path are set. */
static long begin(int fd) {
  long i = atomic_fetch_add(&logged, 1);
  if (i >= LOG_MAX) return -1;
  log_[i].from = now_ns();
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, log_[i].path, PATH_MAX_LOG - 1);
  log_[i].path[n > 0 ? n : 0] = 0;
  return i;
}

static int end(long i, int rc) {
  if (i >= 0) log_[i].to = now_ns();
  return rc;
}

static int slow(void) {
  if (delay_ms < 0) {
    const char *s = getenv("FAKE_FSYNC_MS");
    delay_ms = s ? atol(s) : 0;
  }
  if (nosync < 0) {
    const char *n = getenv("FAKE_FSYNC_NOSYNC");
    nosync = n && n[0] == '1';
  }
  atomic_fetch_add(&syncs, 1);
  if (delay_ms > 0) {
    struct timespec t = { delay_ms / 1000, (delay_ms % 1000) * 1000000L };
    nanosleep(&t, NULL);
  }
  return nosync;
}

int fsync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
  long i = begin(fd);
  if (slow()) return end(i, 0);
  return end(i, real(fd));
}

int fdatasync(int fd) {
  static int (*real)(int);
  if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
  long i = begin(fd);
  if (slow()) return end(i, 0);
  return end(i, real(fd));
}

__attribute__((destructor)) static void report(void) {
  const char *f = getenv("FAKE_FSYNC_REPORT");
  FILE *o = f ? fopen(f, "w") : NULL;
  if (o) {
    fprintf(o, "%ld\n", (long)syncs);
    fclose(o);
  }
  const char *l = getenv("FAKE_FSYNC_LOG");
  o = l ? fopen(l, "w") : NULL;
  if (!o) return;
  long n = atomic_load(&logged);
  if (n > LOG_MAX) n = LOG_MAX; // more were not kept: the test sees fewer lines than syncs
  for (long i = 0; i < n; i++) fprintf(o, "%lld %lld %s\n", log_[i].from, log_[i].to, log_[i].path);
  fclose(o);
}
