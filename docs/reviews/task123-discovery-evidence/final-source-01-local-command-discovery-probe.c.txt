/* Fixed Seatbelt test tree. Readiness messages contain no process identities. */
#define _DARWIN_C_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  alarm(8);
  if (argc != 2) return 64;
  puts("ready");
  fflush(stdout);
  char byte;
  if (read(STDIN_FILENO, &byte, 1) != 1) return 65;
  if (!strcmp(argv[1], "sibling")) for (;;) pause();
  int ready[2];
  if (pipe(ready) != 0) return 66;
  pid_t child = fork();
  if (child < 0) return 67;
  if (child == 0) {
    alarm(8);
    close(ready[0]);
    if (setsid() < 0) _exit(68);
    pid_t grandchild = fork();
    if (grandchild < 0) _exit(69);
    if (grandchild == 0) {
      alarm(8);
      close(ready[1]);
      for (;;) pause();
    }
    if (write(ready[1], "x", 1) != 1) _exit(70);
    close(ready[1]);
    if (read(STDIN_FILENO, &byte, 1) == 1 && byte == 'r') _exit(0);
    for (;;) pause();
  }
  close(ready[1]);
  if (read(ready[0], &byte, 1) != 1) return 71;
  close(ready[0]);
  puts("tree-ready");
  fflush(stdout);
  if (waitpid(child, NULL, 0) != child) return 72;
  puts("reparented");
  fflush(stdout);
  for (;;) pause();
}
