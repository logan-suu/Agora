/* Feasibility probe only. Not exported or used by the product runtime. */
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *stage) {
  fprintf(stderr, "%s:%d\n", stage, errno);
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 3) return 64;
  int root = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) fail("open_root");
  struct statfs fs;
  if (fstatfs(root, &fs)) fail("filesystem");
  if (strcmp(fs.f_fstypename, "apfs")) return 65;
  int parent = openat(root, "moving", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) fail("open_parent");
  int original = openat(parent, "target", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (original < 0) fail("open_original");
  struct stat identity;
  if (fstat(original, &identity) || !S_ISREG(identity.st_mode) || identity.st_nlink != 1)
    fail("original_identity");
  char content[9] = {0};
  if (read(original, content, 8) != 8 || strcmp(content, "original")) return 66;
  int candidate = -1;
  if (!strcmp(argv[2], "write-open-file")) {
    candidate = openat(root, ".agora-operations/candidate", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (candidate < 0) fail("open_candidate");
  } else if (strcmp(argv[2], "exchange")) return 68;
  struct stat root_path, root_fd, parent_path, parent_fd;
  if (lstat(argv[1], &root_path) || fstat(root, &root_fd) ||
      fstatat(root, "moving", &parent_path, AT_SYMLINK_NOFOLLOW) || fstat(parent, &parent_fd))
    fail("verify_directories");
  if (root_path.st_dev != root_fd.st_dev || root_path.st_ino != root_fd.st_ino ||
      parent_path.st_dev != parent_fd.st_dev || parent_path.st_ino != parent_fd.st_ino)
    return 69;
  /* The pipe barrier fixes the race immediately after the last identity check. */
  printf("{\"ready\":true,\"filesystem\":\"%s\"}\n", fs.f_fstypename);
  fflush(stdout);
  char release;
  if (read(STDIN_FILENO, &release, 1) != 1 || release != 'x') return 67;
  if (candidate >= 0) {
    char actual_path[4096] = {0};
    if (fcntl(candidate, F_GETPATH, actual_path)) fail("get_candidate_path");
    int reopened = openat(root, ".agora-operations/candidate", O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    int reopen_error = reopened < 0 ? errno : 0;
    if (reopened >= 0) close(reopened);
    printf("{\"reopenErrno\":%d,\"openedFilePath\":\"%s\"}\n", reopen_error, actual_path);
    if (pwrite(candidate, "prepared!", 9, 0) != 9) fail("write_candidate");
    if (fsync(candidate)) fail("flush_candidate");
    close(candidate);
    puts("{\"wrotePreparedFile\":true}");
    return 0;
  }
  /* Resolve from the root, not the opened parent: a stale parent fd is insufficient. */
  if (renameatx_np(root, ".agora-operations/candidate", root, "moving/target",
                  RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH))
    fail("exchange");
  puts("{\"exchanged\":true}");
  close(original);
  close(parent);
  close(root);
  return 0;
}
