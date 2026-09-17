/* Fixed diagnostic payload. Every spawned process inherits Seatbelt; the
 * controller reaps this parent, which synchronously reaps all descendants. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void report(const char *actor, const char *operation, int result) {
    int saved = result < 0 ? errno : 0;
    printf("{\"actor\":\"%s\",\"operation\":\"%s\",\"ok\":%s,\"errno\":%d}\n",
           actor, operation, result < 0 ? "false" : "true", saved);
    fflush(stdout);
}

static void path(char *out, const char *base, const char *name) {
    int result = snprintf(out, PATH_MAX, "%s/%s", base, name);
    if (result < 0 || result >= PATH_MAX) exit(90);
}

static int write_file(const char *name, int create) {
    int fd = open(name, O_WRONLY | (create ? O_CREAT : 0), 0600);
    if (fd < 0) return -1;
    int result = (int)write(fd, "changed", 7);
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}

static int read_file(const char *name) {
    int fd = open(name, O_RDONLY);
    if (fd < 0) return -1;
    char value;
    int result = (int)read(fd, &value, 1);
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}

static void exercise(const char *actor, const char *base) {
    char source[PATH_MAX], input[PATH_MAX], output[PATH_MAX];
    char other[PATH_MAX], alias[PATH_MAX];
    path(source, base, "source/file");
    path(input, base, "input/file");
    path(output, base, "output");
    path(alias, output, actor);
    report(actor, "read-input", read_file(input));
    report(actor, "write-output", write_file(alias, 1));
    report(actor, "write-source", write_file(source, 0));
    report(actor, "write-input", write_file(input, 0));
    path(other, base, "secrets/file");
    report(actor, "read-secret", read_file(other));
    path(other, base, "control/file");
    report(actor, "read-control", read_file(other));
    path(other, base, "neighbor/file");
    report(actor, "read-neighbor", read_file(other));
    report(actor, "write-neighbor", write_file(other, 0));
    path(alias, output, "symlink");
    unlink(alias);
    int linked = symlink(source, alias);
    report(actor, "symlink-write-source", linked < 0 ? linked : write_file(alias, 0));
    unlink(alias);
    path(alias, output, "hardlink");
    report(actor, "hardlink-source", link(source, alias));
    unlink(alias);
    path(alias, output, "moved-source");
    report(actor, "rename-source", rename(source, alias));
    report(actor, "unlink-source", unlink(source));
    path(other, base, "source/.env");
    report(actor, "read-source-env", read_file(other));
    int fd = open(source, O_RDONLY);
    report(actor, "write-source-via-read-fd", fd < 0 ? -1 : (int)pwrite(fd, "changed", 7, 0));
    if (fd >= 0) close(fd);
}

int main(int argc, char **argv) {
    if (argc != 3) return 91;
    alarm(8);
    if (strcmp(argv[1], "grandchild") == 0) {
        exercise("grandchild", argv[2]);
        return 0;
    }
    if (strcmp(argv[1], "child") != 0) return 92;
    exercise("child", argv[2]);
    pid_t pid = fork();
    if (pid < 0) return 93;
    if (pid == 0) {
        execl(argv[0], argv[0], "grandchild", argv[2], NULL);
        _exit(94);
    }
    int status;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return 95;
    return WEXITSTATUS(status);
}
