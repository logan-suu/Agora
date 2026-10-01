/* Test-only first-load delay; all process observations and signals use the real helper. */
#define main agora_process_control_main
#include "../../../packages/runtime/sandbox/native/local-process-control.c"
#undef main
#include <fcntl.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  char marker[PATH_MAX];
  if (snprintf(marker, sizeof(marker), "%s.loaded", argv[0]) >= PATH_MAX) return 80;
  int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd >= 0) {
    if (write(fd, argv[1], strlen(argv[1])) != (ssize_t)strlen(argv[1]) || close(fd)) return 81;
    usleep(350000);
  } else if (errno != EEXIST) return 82;
  return agora_process_control_main(argc, argv);
}
