/* Trusted fault fixture. Successful observations use the actual kernel helper.
 * Only this test's capture calls are delayed/failed; no identity is fabricated. */
#define main agora_process_control_main
#include "local-process-control.c"
#undef main
#include <fcntl.h>

#ifndef AGORA_CAPTURE_PROBE_MODE
#define AGORA_CAPTURE_PROBE_MODE 1
#endif

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "ready")) {
    if (AGORA_CAPTURE_PROBE_MODE == 6) usleep(350000);
    if (AGORA_CAPTURE_PROBE_MODE == 7) usleep(5100000);
    if (AGORA_CAPTURE_PROBE_MODE == 8) { puts("{\"schemaVersion\":\"invalid\"}"); return 0; }
  }
  if (argc == 3 && !strcmp(argv[1], "capture")) {
    char marker[PATH_MAX];
    if (snprintf(marker, sizeof(marker), "%s.attempts", argv[0]) >= PATH_MAX) return 80;
    int fd = open(marker, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0600);
    if (fd < 0) return 81;
    off_t prior = lseek(fd, 0, SEEK_END);
    if (prior < 0 || write(fd, "c", 1) != 1 || fsync(fd) || close(fd)) return 82;
    if (AGORA_CAPTURE_PROBE_MODE == 3) return 65;
    if (AGORA_CAPTURE_PROBE_MODE == 4) {
      unsigned int pid;
      audit_token_t token = {{0}};
      if (!number(argv[2], &pid) || !token_for_pid((pid_t)pid, &token) ||
          token.val[1] != getuid() || proc_signal_with_audittoken(&token, SIGTERM)) return 83;
    }
    if (((AGORA_CAPTURE_PROBE_MODE == 1 || AGORA_CAPTURE_PROBE_MODE == 4) && prior == 0) ||
        AGORA_CAPTURE_PROBE_MODE == 2) usleep(350000);
  }
  return agora_process_control_main(argc, argv);
}
