/* Fixed Seatbelt payload: bounded lifetime, private marker and no control channel. */
#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  alarm(6);
  const char *home = getenv("HOME");
  if (!home || chdir(home)) return 80;
  int fd = open("running", O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0 || write(fd, "fixed", 5) != 5 || close(fd)) return 81;
  if (argc == 2 && !strcmp(argv[1], "exit")) return 0;
  for (;;) pause();
}
