/* Fixed test payload. It is always launched inside the test Seatbelt policy. */
#define _DARWIN_C_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  alarm(6);
  if (argc != 2) return 64;
  if (!strcmp(argv[1], "ignore-term")) signal(SIGTERM, SIG_IGN);
  puts("ready");
  fflush(stdout);
  char byte;
  if (read(STDIN_FILENO, &byte, 1) != 1) return 65;
  if (!strcmp(argv[1], "flood")) {
    char block[8192];
    memset(block, 'x', sizeof(block));
    for (int i = 0; i < 256; i++) {
      if (write(STDOUT_FILENO, block, sizeof(block)) != sizeof(block) ||
          write(STDERR_FILENO, block, sizeof(block)) != sizeof(block)) return 66;
    }
    return 0;
  }
  if (!strcmp(argv[1], "inherited-pipe")) {
    pid_t child = fork();
    if (child < 0) return 67;
    if (child == 0) {
      alarm(5);
      sleep(4);
      _exit(0);
    }
    return 0;
  }
  for (;;) pause();
}
