/* Fixed trusted test trap: if erroneously invoked, mark only its own fixture path. */
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  (void)argc;
  char path[PATH_MAX];
  if (snprintf(path, sizeof(path), "%s.executed", argv[0]) >= (int)sizeof(path)) return 80;
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return 81;
  if (write(fd, "fixed", 5) != 5 || close(fd)) return 82;
  return 1;
}
