#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define MAX_CLEANUP_ROUNDS 50
#define RETRY_DELAY_NS 10000000L
#define PID_BUFFER_HEADROOM 128
#define INITIAL_USAGE_CAPACITY 128

enum sandbox_filter_type {
  SANDBOX_FILTER_NONE = 0,
  SANDBOX_FILTER_PATH = 1,
};

enum resource_violation {
  RESOURCE_OK = 0,
  RESOURCE_CPU,
  RESOURCE_MEMORY,
  RESOURCE_PROCESSES,
  RESOURCE_DISK_WRITE,
};

struct resource_limits {
  uint64_t cpu_time_ns;
  uint64_t memory_bytes;
  uint64_t max_processes;
  uint64_t disk_write_bytes;
};

struct tracked_usage {
  pid_t pid;
  uint64_t start_time;
  uint64_t cpu_time_ns;
  uint64_t disk_write_bytes;
  int seen;
};

struct usage_ledger {
  struct tracked_usage *entries;
  size_t count;
  size_t capacity;
  uint64_t cpu_time_ns;
  uint64_t disk_write_bytes;
};

/*
 * sandbox_check is macOS SPI. The product already depends on sandbox-exec;
 * the runner rejects helper failures and integration tests verify this
 * companion capability on the target OS.
 */
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t pid, const char *operation,
                         enum sandbox_filter_type type, ...);

static volatile sig_atomic_t stop_requested = 0;

static void handle_stop(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
}

static uint64_t saturating_add(uint64_t left, uint64_t right) {
  if (UINT64_MAX - left < right) {
    return UINT64_MAX;
  }
  return left + right;
}

static uint64_t absolute_time_to_nanoseconds(uint64_t absolute_time) {
  static mach_timebase_info_data_t timebase = {0};
  if (timebase.denom == 0 && mach_timebase_info(&timebase) != KERN_SUCCESS) {
    return UINT64_MAX;
  }
  __uint128_t nanoseconds =
      (__uint128_t)absolute_time * timebase.numer / timebase.denom;
  return nanoseconds > UINT64_MAX ? UINT64_MAX : (uint64_t)nanoseconds;
}

static int parse_uint64(const char *value, uint64_t *result) {
  if (value[0] == '\0' || value[0] == '-') {
    errno = EINVAL;
    return -1;
  }
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    errno = EINVAL;
    return -1;
  }
  *result = (uint64_t)parsed;
  return 0;
}

static int list_user_pids(pid_t **pids, size_t *count) {
  int required_bytes = proc_listpids(PROC_RUID_ONLY, getuid(), NULL, 0);
  if (required_bytes < 0) {
    return -1;
  }

  size_t capacity =
      ((size_t)required_bytes / sizeof(pid_t)) + PID_BUFFER_HEADROOM;
  pid_t *buffer = calloc(capacity, sizeof(pid_t));
  if (buffer == NULL) {
    errno = ENOMEM;
    return -1;
  }

  int returned_bytes = proc_listpids(PROC_RUID_ONLY, getuid(), buffer,
                                    (int)(capacity * sizeof(pid_t)));
  if (returned_bytes < 0) {
    int saved_errno = errno;
    free(buffer);
    errno = saved_errno;
    return -1;
  }

  *pids = buffer;
  *count = (size_t)returned_bytes / sizeof(pid_t);
  return 0;
}

static int path_check(pid_t pid, const char *path) {
  return sandbox_check(
      pid, "file-read-data",
      (enum sandbox_filter_type)(SANDBOX_FILTER_PATH |
                                 SANDBOX_CHECK_NO_REPORT),
      path);
}

static int matches_fingerprint(pid_t pid, const char *allowed_canary,
                               const char *denied_canary, int *matches) {
  *matches = 0;
  errno = 0;
  int sandboxed = sandbox_check(pid, NULL, SANDBOX_FILTER_NONE);
  int sandbox_errno = errno;
  if (sandboxed < 0) {
    if (sandbox_errno == ESRCH) {
      return 0;
    }
    errno = sandbox_errno;
    return -1;
  }
  if (sandboxed != 1) {
    return 0;
  }

  errno = 0;
  int allowed = path_check(pid, allowed_canary);
  int allowed_errno = errno;
  errno = 0;
  int denied = path_check(pid, denied_canary);
  int denied_errno = errno;
  if (allowed < 0 || denied < 0) {
    if ((allowed < 0 && allowed_errno == ESRCH) ||
        (denied < 0 && denied_errno == ESRCH)) {
      return 0;
    }
    errno = allowed < 0 ? allowed_errno : denied_errno;
    return -1;
  }

  *matches = allowed == 0 && denied == 1;
  return 0;
}

static int kill_matching_processes(const char *allowed_canary,
                                   const char *denied_canary,
                                   size_t *remaining) {
  pid_t *pids = NULL;
  size_t count = 0;
  if (list_user_pids(&pids, &count) != 0) {
    return -1;
  }

  size_t live = 0;
  for (size_t index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 1 || pid == getpid()) {
      continue;
    }

    int matches = 0;
    if (matches_fingerprint(pid, allowed_canary, denied_canary, &matches) !=
        0) {
      int saved_errno = errno;
      free(pids);
      errno = saved_errno;
      return -1;
    }
    if (!matches) {
      continue;
    }

    if (kill(pid, SIGKILL) == 0) {
      live += 1;
      continue;
    }
    if (errno != ESRCH) {
      int saved_errno = errno;
      free(pids);
      errno = saved_errno;
      return -1;
    }
  }

  free(pids);
  *remaining = live;
  return 0;
}

static int cleanup_mode(const char *allowed_canary,
                        const char *denied_canary) {
  const struct timespec retry_delay = {
      .tv_sec = 0,
      .tv_nsec = RETRY_DELAY_NS,
  };

  for (int round = 0; round < MAX_CLEANUP_ROUNDS; round += 1) {
    size_t remaining = 0;
    if (kill_matching_processes(allowed_canary, denied_canary, &remaining) !=
        0) {
      perror("process containment inspection failed");
      return 3;
    }
    if (remaining == 0) {
      return 0;
    }
    nanosleep(&retry_delay, NULL);
  }

  size_t remaining = 0;
  if (kill_matching_processes(allowed_canary, denied_canary, &remaining) !=
      0) {
    perror("process containment inspection failed");
    return 3;
  }
  if (remaining != 0) {
    fprintf(stderr, "process containment cleanup did not converge\n");
    return 4;
  }
  return 0;
}

static struct tracked_usage *find_or_add_usage(struct usage_ledger *ledger,
                                                pid_t pid,
                                                uint64_t start_time) {
  for (size_t index = 0; index < ledger->count; index += 1) {
    struct tracked_usage *entry = &ledger->entries[index];
    if (entry->pid == pid && entry->start_time == start_time) {
      return entry;
    }
  }

  if (ledger->count == ledger->capacity) {
    size_t next_capacity = ledger->capacity == 0
                               ? INITIAL_USAGE_CAPACITY
                               : ledger->capacity * 2;
    if (next_capacity < ledger->capacity ||
        next_capacity > SIZE_MAX / sizeof(struct tracked_usage)) {
      errno = EOVERFLOW;
      return NULL;
    }
    struct tracked_usage *next_entries =
        realloc(ledger->entries,
                next_capacity * sizeof(struct tracked_usage));
    if (next_entries == NULL) {
      return NULL;
    }
    ledger->entries = next_entries;
    ledger->capacity = next_capacity;
  }

  struct tracked_usage *entry = &ledger->entries[ledger->count];
  ledger->count += 1;
  *entry = (struct tracked_usage){
      .pid = pid,
      .start_time = start_time,
      .cpu_time_ns = 0,
      .disk_write_bytes = 0,
      .seen = 0,
  };
  return entry;
}

static int sample_resources(const char *allowed_canary,
                            const char *denied_canary,
                            const struct resource_limits *limits,
                            struct usage_ledger *ledger,
                            enum resource_violation *violation) {
  pid_t *pids = NULL;
  size_t count = 0;
  if (list_user_pids(&pids, &count) != 0) {
    return -1;
  }

  uint64_t live_processes = 0;
  uint64_t memory_bytes = 0;
  for (size_t index = 0; index < ledger->count; index += 1) {
    ledger->entries[index].seen = 0;
  }
  for (size_t index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 1 || pid == getpid()) {
      continue;
    }

    int matches = 0;
    if (matches_fingerprint(pid, allowed_canary, denied_canary, &matches) !=
        0) {
      int saved_errno = errno;
      free(pids);
      errno = saved_errno;
      return -1;
    }
    if (!matches) {
      continue;
    }

    struct rusage_info_v4 usage = {0};
    errno = 0;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
      if (errno == ESRCH) {
        continue;
      }
      int saved_errno = errno;
      free(pids);
      errno = saved_errno;
      return -1;
    }

    live_processes = saturating_add(live_processes, 1);
    memory_bytes = saturating_add(memory_bytes, usage.ri_phys_footprint);
    struct tracked_usage *entry =
        find_or_add_usage(ledger, pid, usage.ri_proc_start_abstime);
    if (entry == NULL) {
      int saved_errno = errno;
      free(pids);
      errno = saved_errno;
      return -1;
    }
    entry->seen = 1;

    uint64_t cpu_time = absolute_time_to_nanoseconds(
        saturating_add(usage.ri_user_time, usage.ri_system_time));
    if (cpu_time >= entry->cpu_time_ns) {
      ledger->cpu_time_ns =
          saturating_add(ledger->cpu_time_ns,
                         cpu_time - entry->cpu_time_ns);
    }
    entry->cpu_time_ns = cpu_time;

    if (usage.ri_logical_writes >= entry->disk_write_bytes) {
      ledger->disk_write_bytes =
          saturating_add(ledger->disk_write_bytes,
                         usage.ri_logical_writes -
                             entry->disk_write_bytes);
    }
    entry->disk_write_bytes = usage.ri_logical_writes;
  }
  free(pids);

  size_t retained = 0;
  for (size_t index = 0; index < ledger->count; index += 1) {
    if (!ledger->entries[index].seen) {
      continue;
    }
    ledger->entries[retained] = ledger->entries[index];
    retained += 1;
  }
  ledger->count = retained;

  if (ledger->cpu_time_ns > limits->cpu_time_ns) {
    *violation = RESOURCE_CPU;
  } else if (memory_bytes > limits->memory_bytes) {
    *violation = RESOURCE_MEMORY;
  } else if (live_processes > limits->max_processes) {
    *violation = RESOURCE_PROCESSES;
  } else if (ledger->disk_write_bytes > limits->disk_write_bytes) {
    *violation = RESOURCE_DISK_WRITE;
  } else {
    *violation = RESOURCE_OK;
  }
  return 0;
}

static const char *violation_name(enum resource_violation violation) {
  switch (violation) {
    case RESOURCE_CPU:
      return "CPU";
    case RESOURCE_MEMORY:
      return "MEMORY";
    case RESOURCE_PROCESSES:
      return "PROCESSES";
    case RESOURCE_DISK_WRITE:
      return "DISK_WRITE";
    case RESOURCE_OK:
      return "OK";
  }
}

static int monitor_mode(const char *allowed_canary,
                        const char *denied_canary,
                        const struct resource_limits *limits) {
  struct sigaction action = {0};
  action.sa_handler = handle_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0) {
    perror("resource monitor signal setup failed");
    return 3;
  }

  struct usage_ledger ledger = {0};
  const struct timespec retry_delay = {
      .tv_sec = 0,
      .tv_nsec = RETRY_DELAY_NS,
  };
  printf("READY\n");
  fflush(stdout);

  while (1) {
    enum resource_violation violation = RESOURCE_OK;
    if (sample_resources(allowed_canary, denied_canary, limits, &ledger,
                         &violation) != 0) {
      perror("resource monitor inspection failed");
      free(ledger.entries);
      return 3;
    }
    if (violation != RESOURCE_OK) {
      printf("LIMIT %s\n", violation_name(violation));
      fflush(stdout);
      free(ledger.entries);
      return 20;
    }
    if (stop_requested) {
      free(ledger.entries);
      return 0;
    }
    nanosleep(&retry_delay, NULL);
  }
}

static int exec_mode(uint64_t cpu_seconds, uint64_t file_size_bytes,
                     char **command_argv) {
  struct rlimit cpu_limit = {
      .rlim_cur = (rlim_t)cpu_seconds,
      .rlim_max = (rlim_t)saturating_add(cpu_seconds, 1),
  };
  if (setrlimit(RLIMIT_CPU, &cpu_limit) != 0) {
    perror("CPU limit setup failed");
    return 5;
  }

  struct rlimit file_size_limit = {
      .rlim_cur = (rlim_t)file_size_bytes,
      .rlim_max = (rlim_t)file_size_bytes,
  };
  if (setrlimit(RLIMIT_FSIZE, &file_size_limit) != 0) {
    perror("file size limit setup failed");
    return 5;
  }

  execv(command_argv[0], command_argv);
  perror("resource-limited command exec failed");
  return 6;
}

int main(int argc, char **argv) {
  if (sandbox_check(getpid(), NULL, SANDBOX_FILTER_NONE) < 0) {
    perror("sandbox process query is unavailable");
    return 3;
  }

  if (argc == 4 && strcmp(argv[1], "cleanup") == 0) {
    return cleanup_mode(argv[2], argv[3]);
  }

  if (argc == 8 && strcmp(argv[1], "monitor") == 0) {
    struct resource_limits limits = {0};
    if (parse_uint64(argv[4], &limits.cpu_time_ns) != 0 ||
        parse_uint64(argv[5], &limits.memory_bytes) != 0 ||
        parse_uint64(argv[6], &limits.max_processes) != 0 ||
        parse_uint64(argv[7], &limits.disk_write_bytes) != 0) {
      perror("invalid resource monitor limit");
      return 2;
    }
    return monitor_mode(argv[2], argv[3], &limits);
  }

  if (argc >= 5 && strcmp(argv[1], "exec") == 0) {
    uint64_t cpu_seconds = 0;
    uint64_t file_size_bytes = 0;
    if (parse_uint64(argv[2], &cpu_seconds) != 0 ||
        parse_uint64(argv[3], &file_size_bytes) != 0 ||
        cpu_seconds == 0 || file_size_bytes == 0) {
      perror("invalid resource exec limit");
      return 2;
    }
    return exec_mode(cpu_seconds, file_size_bytes, &argv[4]);
  }

  fprintf(stderr,
          "usage: %s cleanup <allowed-canary> <denied-canary>\n"
          "       %s monitor <allowed-canary> <denied-canary> "
          "<cpu-ns> <memory-bytes> <max-processes> <disk-write-bytes>\n"
          "       %s exec <cpu-seconds> <file-size-bytes> <command> [args...]\n",
          argv[0], argv[0], argv[0]);
  return 2;
}
