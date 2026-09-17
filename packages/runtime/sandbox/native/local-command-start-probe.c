/* Fixed validation payload: constructor runs before main, with no ready barrier. */
#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void first_instruction(void) {
  const char *home = getenv("HOME");
  if (!home || chdir(home)) _exit(80);
  int fd = open("constructor-ran", O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(81);
  if (write(fd, "yes", 3) != 3 || close(fd)) _exit(82);
}

int main(int argc, char **argv) {
  (void)argv;
  alarm(5);
  if (argc == 2) raise(SIGUSR1);
  int extra = 0;
  for (int fd = 3; fd < 1024; fd++) if (fcntl(fd, F_GETFD) != -1) extra++;
  printf("{\"extraFds\":%d,\"inheritedSecret\":%s}\n", extra,
    getenv("AGORA_FIXED_FAKE_SECRET") ? "true" : "false");
  return 7;
}
