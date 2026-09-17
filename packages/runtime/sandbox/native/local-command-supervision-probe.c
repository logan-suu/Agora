/* Fixed Seatbelt payload. The command pipe controls timing, never membership. */
#define _DARWIN_C_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  alarm(40);
  if (argc != 2) return 64;
  puts("ready");
  fflush(stdout);
  char byte;
  if (read(STDIN_FILENO, &byte, 1) != 1) return 65;
  if (!strcmp(argv[1], "single")) for (;;) pause();
  int ready[2];
  if (pipe(ready) != 0) return 66;
  pid_t child = fork();
  if (child < 0) return 67;
  if (child == 0) {
    alarm(40);
    close(ready[0]);
    if (setsid() < 0) _exit(68);
    pid_t grandchild = fork();
    if (grandchild < 0) _exit(69);
    if (grandchild == 0) {
      alarm(40);
      close(ready[1]);
      for (;;) pause();
    }
    if (write(ready[1], "x", 1) != 1) _exit(70);
    close(ready[1]);
    for (;;) pause();
  }
  close(ready[1]);
  if (read(ready[0], &byte, 1) != 1) return 71;
  close(ready[0]);
  puts("tree-ready");
  fflush(stdout);
  while (read(STDIN_FILENO, &byte, 1) == 1) if (byte == 'e') return 0;
  for (;;) pause();
}
