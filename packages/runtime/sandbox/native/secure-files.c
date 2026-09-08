/* Trusted POSIX helper. fd 3 is the identity-checked root supplied by the host. */
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CAP 16384
#define DEPTH 128
static const char *root_alias;
static void fail(const char *message) {
  fprintf(stderr, "%s: %s\n", message, strerror(errno));
  exit(1);
}
static void copy(char *to, const char *from) {
  if (strlen(from) >= CAP) { errno = ENAMETOOLONG; fail("path too long"); }
  strcpy(to, from);
}
static const char *relative_path(const char *path, const char *root) {
  if (*path != '/') return path;
  size_t length = strlen(root);
  if (strncmp(path, root, length) || (path[length] && path[length] != '/')) {
    length = strlen(root_alias);
    if (strncmp(path, root_alias, length) || (path[length] && path[length] != '/')) {
      errno = EPERM; fail("path escapes worktree root");
    }
  }
  return path + length + (path[length] == '/');
}
static void regular(int fd) {
  struct stat st;
  if (fstat(fd, &st)) fail("cannot inspect opened file");
  if (!S_ISREG(st.st_mode)) { errno = EPERM; fail("special file refused"); }
  if (st.st_nlink != 1) { errno = EPERM; fail("hard link refused"); }
}

/* Resolve every component ourselves. Never ask a subsequent syscall to follow links. */
static int open_file(const char *root, const char *path, int writing) {
  int dirs[DEPTH], depth = 0, links = 0;
  dirs[0] = dup(3);
  if (dirs[0] < 0) fail("cannot duplicate root");
  char pending[CAP]; copy(pending, relative_path(path, root));
  for (;;) {
    char name[CAP], rest[CAP];
    char *slash = strchr(pending, '/');
    if (slash) { *slash = 0; copy(rest, slash + 1); } else rest[0] = 0;
    copy(name, pending);
    if (!name[0] || !strcmp(name, ".")) {
      if (!rest[0]) { errno = EISDIR; fail("file path required"); }
      copy(pending, rest); continue;
    }
    if (!strcmp(name, "..")) {
      if (!depth) { errno = EPERM; fail("path escapes worktree root"); }
      close(dirs[depth--]); copy(pending, rest); continue;
    }
    int final = !rest[0];
    int flags = O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
    flags |= final ? (writing ? O_WRONLY : O_RDONLY) : (O_RDONLY | O_DIRECTORY);
    int fd = openat(dirs[depth], name, flags);
    if (fd < 0 && errno == ENOENT && writing) {
      if (final) fd = openat(dirs[depth], name, flags | O_CREAT | O_EXCL, 0600);
      else {
        if (mkdirat(dirs[depth], name, 0700) && errno != EEXIST) fail("cannot create directory");
        fd = openat(dirs[depth], name, flags);
      }
    }
    if (fd < 0) {
      char target[CAP], next[CAP];
      ssize_t count = readlinkat(dirs[depth], name, target, sizeof(target) - 1);
      if (count < 0) fail("cannot open confined path");
      if (count == (ssize_t)sizeof(target) - 1 || ++links > 40) {
        errno = ELOOP; fail("symbolic link limit exceeded");
      }
      target[count] = 0;
      const char *part = relative_path(target, root);
      if (target[0] == '/') while (depth) close(dirs[depth--]);
      int length = snprintf(next, sizeof(next), "%s%s%s", part, rest[0] ? "/" : "", rest);
      if (length < 0 || length >= CAP) { errno = ENAMETOOLONG; fail("path too long"); }
      copy(pending, next); continue;
    }
    if (final) {
      regular(fd);
      for (int i = depth; i >= 0; i--) close(dirs[i]);
      return fd;
    }
    if (depth + 1 >= DEPTH) { errno = ELOOP; fail("directory depth exceeded"); }
    dirs[++depth] = fd;
    copy(pending, rest);
  }
}

static void write_all(int fd, const char *buffer, size_t size) {
  while (size) {
    ssize_t count = write(fd, buffer, size);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail("write failed");
    buffer += count; size -= (size_t)count;
  }
}
static void transfer(int source, int destination) {
  char buffer[65536];
  for (;;) {
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail("read failed");
    if (!count) return;
    write_all(destination, buffer, (size_t)count);
  }
}

static void list(int fd, const char *prefix, int depth) {
  if (depth >= DEPTH) { errno = ELOOP; fail("directory depth exceeded"); }
  DIR *dir = fdopendir(fd);
  if (!dir) fail("cannot list directory");
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) { if (errno) fail("cannot read directory"); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) fail("cannot inspect entry");
    char path[CAP];
    int length = snprintf(path, sizeof(path), "%s%s%s", prefix, *prefix ? "/" : "", entry->d_name);
    if (length < 0 || length >= CAP) { errno = ENAMETOOLONG; fail("path too long"); }
    if (S_ISDIR(st.st_mode)) {
      if (!strcmp(entry->d_name, ".git") || !strcmp(entry->d_name, "node_modules") || !strcmp(entry->d_name, ".data")) continue;
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) fail("directory changed during traversal");
      list(child, path, depth + 1);
    } else if (S_ISREG(st.st_mode)) {
      if (st.st_nlink != 1) { errno = EPERM; fail("hard link refused"); }
      write_all(STDOUT_FILENO, path, strlen(path) + 1);
    } else if (!S_ISLNK(st.st_mode)) { errno = EPERM; fail("special file refused"); }
  }
  closedir(dir);
}

/* The destination is a new, trusted staging directory, never a model-owned tree. */
static void snapshot(int source, int destination, const char *root, const char *prefix, int depth) {
  if (depth >= DEPTH) { errno = ELOOP; fail("directory depth exceeded"); }
  DIR *dir = fdopendir(source);
  if (!dir) fail("cannot snapshot directory");
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) { if (errno) fail("cannot read directory"); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || !strcmp(entry->d_name, ".git")) continue;
    struct stat st;
    if (fstatat(source, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) fail("cannot inspect snapshot entry");
    char path[CAP];
    int length = snprintf(path, sizeof(path), "%s%s%s", prefix, *prefix ? "/" : "", entry->d_name);
    if (length < 0 || length >= CAP) { errno = ENAMETOOLONG; fail("path too long"); }
    if (S_ISDIR(st.st_mode)) {
      int child = openat(source, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) fail("snapshot directory changed");
      if (mkdirat(destination, entry->d_name, 0700)) fail("cannot create snapshot directory");
      int output = openat(destination, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (output < 0) fail("cannot open snapshot directory");
      snapshot(child, output, root, path, depth + 1);
      close(output);
    } else {
      int input = open_file(root, path, 0);
      if (fstat(input, &st)) fail("cannot inspect snapshot file");
      int output = openat(destination, entry->d_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, st.st_mode & 0777);
      if (output < 0) fail("cannot create snapshot file");
      transfer(input, output);
      if (close(input) || close(output)) fail("cannot close snapshot file");
    }
  }
  closedir(dir);
}

static void measure(int fd, int depth, unsigned long long *logical, unsigned long long *allocated) {
  if (depth >= DEPTH) { errno = ELOOP; fail("directory depth exceeded"); }
  DIR *dir = fdopendir(fd);
  if (!dir) fail("cannot measure directory");
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) { if (errno) fail("cannot read directory"); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) fail("cannot inspect measured entry");
    if (S_ISDIR(st.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) fail("measured directory changed");
      measure(child, depth + 1, logical, allocated);
    } else {
      if (!S_ISREG(st.st_mode) && !S_ISLNK(st.st_mode)) { errno = EPERM; fail("special file refused"); }
      *logical += (unsigned long long)st.st_size;
      *allocated += (unsigned long long)st.st_blocks * 512;
    }
  }
  closedir(dir);
}

int main(int argc, char **argv) {
  if (argc != 5) { errno = EINVAL; fail("expected operation root path alias"); }
  root_alias = argv[4];
  struct stat root;
  if (fstat(3, &root) || !S_ISDIR(root.st_mode)) fail("invalid root descriptor");
  if (!strcmp(argv[1], "list")) { list(dup(3), "", 0); return 0; }
  if (!strcmp(argv[1], "snapshot")) { snapshot(dup(3), 4, argv[2], "", 0); return 0; }
  if (!strcmp(argv[1], "measure")) {
    unsigned long long logical = 0, allocated = 0;
    measure(dup(3), 0, &logical, &allocated);
    printf("{\"logicalBytes\":%llu,\"allocatedBytes\":%llu}\n", logical, allocated);
    return 0;
  }
  int writing = !strcmp(argv[1], "write");
  if (!writing && strcmp(argv[1], "read")) { errno = EINVAL; fail("unknown operation"); }
  int fd = open_file(argv[2], argv[3], writing);
  if (writing) {
    if (ftruncate(fd, 0)) fail("truncate failed");
    transfer(STDIN_FILENO, fd);
  } else transfer(fd, STDOUT_FILENO);
  if (close(fd)) fail("close failed");
  return 0;
}
