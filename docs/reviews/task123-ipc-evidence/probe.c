#include <errno.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
static void probe(const char *socket_path, const char *actor) {
  mach_port_t service = MACH_PORT_NULL;
  kern_return_t code = bootstrap_look_up(bootstrap_port, "com.apple.SecurityServer", &service);
  if (code == KERN_SUCCESS) mach_port_deallocate(mach_task_self(), service);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0), connected = -1, error = errno;
  if (fd >= 0) {
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(address.sun_path)) exit(4);
    strcpy(address.sun_path, socket_path);
    connected = connect(fd, (const struct sockaddr *)&address, sizeof(address)); error = errno;
    close(fd);
  }
  printf("{\"actor\":\"%s\",\"securitydLookup\":%d,\"unixConnected\":%s,\"unixErrno\":%d}\n",actor,code,connected==0?"true":"false",connected==0?0:error);
  fflush(stdout);
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  probe(argv[1], "parent");
  pid_t child = fork(); if (child < 0) return 3;
  if (!child) { probe(argv[1], "child"); return 0; }
  int status = 0; if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 5;
  return WEXITSTATUS(status);
}
