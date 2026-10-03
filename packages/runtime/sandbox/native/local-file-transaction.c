/* Trusted file and empty-directory transactions. Never executes project programs.
 * fd 3: immutable expected bytes; fd 4: immutable replacement bytes.
 * The host durably journals intent and authorizes each checkpoint on stdin.
 * This internal primitive is not a grant registry or a public workspace port. */
#define _DARWIN_C_SOURCE
#include <CommonCrypto/CommonDigest.h>
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <unistd.h>

#define LIMIT 128
#define PATH_CAP 4096
#define FILE_CAP (16 * 1024 * 1024)
static int directories[LIMIT], directory_count;
static struct stat directory_ids[LIMIT];
static char directory_names[LIMIT][PATH_CAP];
static int root_fd, staging_fd, original_fd = -1;
static struct stat staging_id, expected_id;
static const char *root_path, *target_path, *staging_name, *preserved_name;
static int exchanged, creating, removing;
static char baseline_metadata[128], candidate_metadata[128];
static int directory_operation, directory_known, metadata_root;
static struct stat result_directory;
static char result_directory_metadata[128];

static void finish(const char *stage, const char *reason, int code) {
  /* The process cannot fork. The host waits for exit, which closes all descriptors;
   * this provisional result line alone is never evidence of quiescence. */
  printf("{\"event\":\"result\",\"stage\":\"%s\",\"reason\":\"%s\",\"%s\":%s",
         stage, reason, creating ? "created" : removing ? "removed" : "exchanged", exchanged ? "true" : "false");
  if (directory_operation) {
    if (directory_known) printf(",\"directory\":{\"identity\":\"%ju:%ju\",\"metadata\":\"%s\"}",
      (uintmax_t)result_directory.st_dev, (uintmax_t)result_directory.st_ino, result_directory_metadata);
    else printf(",\"directory\":null");
  }
  puts("}");
  fflush(stdout);
  exit(code);
}
static void failure(const char *reason) { finish("recoveryRequired", reason, 1); }
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
/* Match the host's locale-independent reserved ASCII names. */
static int reserved_name(const char *name) {
  char folded[PATH_CAP];
  size_t length = strlen(name);
  if (length >= sizeof(folded)) failure("invalid_request");
  for (size_t i = 0; i <= length; i++) {
    unsigned char c = (unsigned char)name[i];
    folded[i] = c >= 'A' && c <= 'Z' ? (char)(c + ('a' - 'A')) : (char)c;
  }
  return !strcmp(folded, ".agora-operations") || !strcmp(folded, ".git") ||
    !strcmp(folded, ".env") || !strncmp(folded, ".env.", 5);
}
static int open_directory(int parent, const char *name) {
  return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}
static void remember(int fd, const char *name) {
  if (fd < 0) fprintf(stderr, "directory_open:%d\n", errno);
  if (fd < 0 || directory_count >= LIMIT || strlen(name) >= PATH_CAP)
    failure("root_identity_changed");
  directories[directory_count] = fd;
  strcpy(directory_names[directory_count], name);
  if (fstat(fd, &directory_ids[directory_count])) failure("root_identity_changed");
  directory_count++;
}
static void verify_directories(void) {
  struct stat current;
  for (int i = 0; i < directory_count; i++) {
    int result = i == 0 ? lstat("/", &current) :
      fstatat(directories[i - 1], directory_names[i], &current, AT_SYMLINK_NOFOLLOW);
    if (result || !S_ISDIR(current.st_mode) || !same(&current, &directory_ids[i]))
      failure("root_identity_changed");
  }
  if (fstatat(root_fd, staging_name, &current, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(current.st_mode) || !same(&current, &staging_id))
    failure("root_identity_changed");
}
static void checkpoint(const char *name) {
  printf("{\"event\":\"checkpoint\",\"name\":\"%s\",\"exchanged\":%s}\n",
         name, exchanged ? "true" : "false");
  fflush(stdout);
  char ack;
  if (read(STDIN_FILENO, &ack, 1) != 1 || ack != 'x') failure("authorization_closed");
  verify_directories();
}
static void parse_identity(const char *text, struct stat *st) {
  uintmax_t dev, ino;
  char tail;
  if (sscanf(text, "%ju:%ju%c", &dev, &ino, &tail) != 2) failure("invalid_request");
  st->st_dev = (dev_t)dev;
  st->st_ino = (ino_t)ino;
}
static void pin_root(const char *chain) {
  if (root_path[0] != '/' || strlen(root_path) >= PATH_CAP || strlen(chain) >= PATH_CAP)
    failure("invalid_request");
  char path[PATH_CAP], identities[PATH_CAP];
  strcpy(path, root_path + 1);
  strcpy(identities, chain);
  remember(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC), "");
  char *save = NULL;
  for (char *part = strtok_r(path, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) failure("invalid_request");
    remember(open_directory(directories[directory_count - 1], part), part);
  }
  char *id_save = NULL;
  int i = 0;
  for (char *part = strtok_r(identities, ",", &id_save); part; part = strtok_r(NULL, ",", &id_save)) {
    struct stat identity = {0};
    parse_identity(part, &identity);
    if (i >= directory_count || !same(&identity, &directory_ids[i++])) failure("root_identity_changed");
  }
  if (i != directory_count) failure("root_identity_changed");
  root_fd = directories[directory_count - 1];
  struct statfs filesystem;
  if (fstatfs(root_fd, &filesystem) || strcmp(filesystem.f_fstypename, "apfs"))
    failure("unsupported_workspace");
}
static void pin_parents(const char *expected_parents) {
  if (!*target_path || target_path[0] == '/' || strlen(target_path) >= PATH_CAP)
    failure("invalid_request");
  char components[PATH_CAP];
  strcpy(components, target_path);
  char *part_start = components;
  for (;;) {
    char *slash = strchr(part_start, '/');
    if (slash) *slash = 0;
    if (!*part_start || !strcmp(part_start, ".") || !strcmp(part_start, "..") ||
        reserved_name(part_start)) failure("invalid_request");
    if (!slash) break;
    part_start = slash + 1;
  }
  int first = directory_count;
  char path[PATH_CAP];
  strcpy(path, target_path);
  char *last = strrchr(path, '/');
  if (last) {
    *last = 0;
    char *save = NULL;
    for (char *part = strtok_r(path, "/", &save); part; part = strtok_r(NULL, "/", &save))
      remember(open_directory(directories[directory_count - 1], part), part);
  }
  if (strlen(expected_parents) >= PATH_CAP) failure("invalid_request");
  char ids[PATH_CAP]; strcpy(ids, expected_parents);
  char *save = NULL;
  int index = first;
  for (char *part = strtok_r(ids, ",", &save); part; part = strtok_r(NULL, ",", &save)) {
    struct stat expected = {0};
    parse_identity(part, &expected);
    if (index >= directory_count || !same(&expected, &directory_ids[index++]))
      failure("root_identity_changed");
  }
  if (index != directory_count) failure("root_identity_changed");
}
static int supported_object(int fd, struct stat *st, int directory) {
  if (fstat(fd, st) || (directory ? !S_ISDIR(st->st_mode) : (!S_ISREG(st->st_mode) || st->st_nlink != 1)) ||
      st->st_uid != getuid() || (st->st_mode & 07000) || st->st_flags ||
      (!directory && (st->st_size < 0 || st->st_size > FILE_CAP))) {
    fprintf(stderr, "file_stat_unsupported:%d\n", errno); return 0;
  }
  /* Extended attributes are hashed and copied; nonempty ACLs remain unsupported. */
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) { fprintf(stderr, "file_acl_missing:%d\n", errno); return errno == ENOENT; }
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  int error = errno;
  acl_free(acl);
  if (result != -1 || error != EINVAL) fprintf(stderr, "file_acl_entries:%d:%d\n", result, error);
  return result == -1 && error == EINVAL;
}
static int supported_file(int fd, struct stat *st) { return supported_object(fd, st, 0); }
static int compare_names(const void *a, const void *b) {
  return strcmp(*(const char *const *)a, *(const char *const *)b);
}
struct listing_entry { char name[256]; const char *kind; };
static int compare_entries(const void *a, const void *b) {
  return strcmp(((const struct listing_entry *)a)->name, ((const struct listing_entry *)b)->name);
}
static int list_directory(void) {
  int fd = directories[directory_count - 1];
  struct stat before, after;
  if (fstat(fd, &before)) failure("directory_read_failed");
  DIR *stream = fdopendir(dup(fd));
  if (!stream) failure("directory_read_failed");
  struct listing_entry *entries = calloc(4096, sizeof(*entries));
  if (!entries) failure("directory_read_failed");
  size_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) failure("directory_read_failed"); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (count == 4096 || strlen(entry->d_name) >= sizeof(entries[count].name)) failure("directory_limit");
    strcpy(entries[count].name, entry->d_name);
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) failure("directory_version_conflict");
    entries[count].kind = reserved_name(entry->d_name) ? "excluded" :
      S_ISDIR(st.st_mode) && !st.st_flags ? "directory" :
      S_ISREG(st.st_mode) && st.st_nlink == 1 && !st.st_flags ? "file" : "unsupported";
    count++;
  }
  closedir(stream);
  if (fstat(fd, &after) || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
      before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
      before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) failure("directory_version_conflict");
  verify_directories();
  qsort(entries, count, sizeof(*entries), compare_entries);
  printf("{\"identity\":\"%ju:%ju\",\"entries\":[", (uintmax_t)before.st_dev, (uintmax_t)before.st_ino);
  for (size_t i = 0; i < count; i++) {
    printf("%s{\"hex\":\"", i ? "," : "");
    for (const unsigned char *p = (const unsigned char *)entries[i].name; *p; p++) printf("%02x", *p);
    printf("\",\"kind\":\"%s\"}", entries[i].kind);
  }
  puts("]}");
  free(entries);
  return 0;
}
static int object_metadata(int fd, char result[128], int directory) {
  struct stat st;
  if (!supported_object(fd, &st, directory)) return 0;
  char names[65536], *sorted[1024];
  ssize_t count = flistxattr(fd, names, sizeof(names), 0);
  if (count < 0) return 0;
  size_t entries = 0;
  for (size_t offset = 0; offset < (size_t)count;) {
    size_t length = strnlen(names + offset, (size_t)count - offset);
    if (!length || offset + length >= (size_t)count || entries == 1024) return 0;
    sorted[entries++] = names + offset;
    offset += length + 1;
  }
  qsort(sorted, entries, sizeof(char *), compare_names);
  CC_SHA256_CTX hash;
  CC_SHA256_Init(&hash);
  for (size_t i = 0; i < entries; i++) {
    unsigned char value[65536];
    ssize_t size = fgetxattr(fd, sorted[i], value, sizeof(value), 0, 0);
    if (size < 0) return 0;
    uint64_t length = (uint64_t)size;
    CC_SHA256_Update(&hash, sorted[i], (CC_LONG)strlen(sorted[i]) + 1);
    CC_SHA256_Update(&hash, &length, sizeof(length));
    CC_SHA256_Update(&hash, value, (CC_LONG)size);
  }
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  char hex[65];
  CC_SHA256_Final(bytes, &hash);
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(hex + i * 2, 3, "%02x", bytes[i]);
  snprintf(result, 128, "%u:%u:%u:%s", st.st_mode, st.st_uid, st.st_gid, hex);
  return 1;
}
static int metadata(int fd, char result[128]) { return object_metadata(fd, result, 0); }
static int bytes_equal(int a, int b) {
  char aa[65536], bb[65536];
  off_t offset = 0;
  for (;;) {
    ssize_t an = pread(a, aa, sizeof(aa), offset), bn = pread(b, bb, sizeof(bb), offset);
    if (an < 0 || bn < 0 || an != bn || (an && memcmp(aa, bb, (size_t)an))) return 0;
    if (!an) return 1;
    offset += an;
    if (offset > FILE_CAP) return 0;
  }
}
static int same_version(int fd, int bytes, const struct stat *identity, const char *expected_metadata) {
  struct stat before, after;
  char observed_metadata[128];
  if (!supported_file(fd, &before) || !same(&before, identity) ||
      before.st_mode != identity->st_mode || before.st_uid != identity->st_uid ||
      before.st_gid != identity->st_gid || !metadata(fd, observed_metadata) ||
      strcmp(observed_metadata, expected_metadata) || !bytes_equal(fd, bytes) || fstat(fd, &after)) return 0;
  return same(&before, &after) && before.st_size == after.st_size &&
    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
    before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
    before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
}
static int open_target(void) {
  const char *leaf = strrchr(target_path, '/');
  return openat(directories[directory_count - 1], leaf ? leaf + 1 : target_path,
                O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
}

/* Never filter exclusions: even one hidden entry makes a directory nonempty. */
static int empty_directory(int fd) {
  int read_fd = open_directory(fd, ".");
  if (read_fd < 0) return 0;
  DIR *stream = fdopendir(read_fd);
  if (!stream) { close(read_fd); return 0; }
  int empty = 1;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) empty = 0; break; }
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { empty = 0; break; }
  }
  closedir(stream);
  return empty;
}
static int directory_version(int fd, const struct stat *wanted, const char *wanted_metadata,
                             struct stat *observed, char observed_metadata[128]) {
  struct stat after;
  if (!supported_object(fd, observed, 1) || (wanted && !same(observed, wanted)) ||
      !object_metadata(fd, observed_metadata, 1) ||
      (wanted_metadata && strcmp(wanted_metadata, observed_metadata)) ||
      !empty_directory(fd) || fstat(fd, &after)) return 0;
  return same(observed, &after) && observed->st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
    observed->st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
    observed->st_ctimespec.tv_sec == after.st_ctimespec.tv_sec &&
    observed->st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
}
static int target_absent(void) {
  struct stat current;
  const char *leaf = strrchr(target_path, '/');
  return fstatat(directories[directory_count - 1], leaf ? leaf + 1 : target_path,
                 &current, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT;
}
static void record_directory(const struct stat *st, const char *value) {
  result_directory = *st;
  strcpy(result_directory_metadata, value);
  directory_known = 1;
}
static int directory_transaction(char **argv, int inspecting, int verifying) {
  struct stat wanted = {0}, observed;
  char value[128], candidate[128], relative_candidate[256];
  snprintf(candidate, sizeof(candidate), "%s-candidate", inspecting ? "unused" : argv[8]);
  snprintf(relative_candidate, sizeof(relative_candidate), "%s/%s", staging_name, candidate);
  if (inspecting) {
    int fd = metadata_root ? dup(root_fd) : preserved_name ? open_directory(staging_fd, preserved_name) : open_target();
    if (inspecting == 2) {
      struct stat after;
      char after_value[128];
      if (fd < 0 || !supported_object(fd, &observed, 1) || !object_metadata(fd, value, 1) ||
          fstat(fd, &after) || !same(&observed, &after) || !object_metadata(fd, after_value, 1) ||
          strcmp(value, after_value) || observed.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
          observed.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec)
        failure("directory_version_conflict");
    } else if (fd < 0 || !directory_version(fd, NULL, NULL, &observed, value))
      failure("directory_version_conflict");
    close(fd);
    verify_directories();
    printf("{\"identity\":\"%ju:%ju\",\"metadata\":\"%s\"}\n",
      (uintmax_t)observed.st_dev, (uintmax_t)observed.st_ino, value);
    return 0;
  }
  if (verifying) {
    parse_identity(argv[6], &wanted);
    int fd = creating ? open_target() : open_directory(staging_fd, candidate);
    if (fd < 0 || !directory_version(fd, &wanted, argv[7], &observed, value))
      failure("post_directory_conflict");
    close(fd);
    if (removing && !target_absent()) failure("post_directory_conflict");
    verify_directories();
    record_directory(&observed, value);
    exchanged = 1;
    finish("applied", "none", 0);
  }
  if (creating) {
    parse_identity(argv[7], &wanted);
    if (!same(&wanted, &directory_ids[directory_count - 1]) || !target_absent())
      finish("conflict", "directory_version_conflict", 1);
  } else {
    parse_identity(argv[6], &wanted);
    int fd = open_target();
    if (fd < 0 || !directory_version(fd, &wanted, argv[7], &observed, value))
      finish("conflict", "directory_version_conflict", 1);
    close(fd);
    record_directory(&observed, value);
  }
  checkpoint("before_prepare");
  if (creating) {
    if (mkdirat(staging_fd, candidate, 0700)) failure("candidate_unavailable");
    int fd = open_directory(staging_fd, candidate);
    if (fd < 0) failure("candidate_failed");
    verify_directories();
    if (fchmod(fd, 0755) || fsync(fd) || !directory_version(fd, NULL, NULL, &observed, value))
      failure("candidate_failed");
    record_directory(&observed, value);
    close(fd);
    verify_directories();
    if (fsync(staging_fd)) failure("flush_failed");
  } else {
    struct stat occupied;
    if (!fstatat(staging_fd, candidate, &occupied, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)
      failure("candidate_unavailable");
  }
  checkpoint("before_swap");
  int fd = creating ? open_directory(staging_fd, candidate) : open_target();
  if (fd < 0 || !directory_version(fd, &result_directory, result_directory_metadata, &observed, value) ||
      (creating && !target_absent())) finish("conflict", "directory_version_conflict", 1);
  close(fd);
  verify_directories();
  if (renameatx_np(root_fd, creating ? relative_candidate : target_path,
                  root_fd, creating ? target_path : relative_candidate,
                  RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH)) {
    if (creating && errno == EEXIST) finish("conflict", "directory_version_conflict", 1);
    failure("directory_move_refused");
  }
  exchanged = 1;
  checkpoint("after_swap");
  fd = creating ? open_target() : open_directory(staging_fd, candidate);
  if (fd < 0 || !directory_version(fd, &result_directory, result_directory_metadata, &observed, value) ||
      (removing && !target_absent())) failure("post_directory_conflict");
  close(fd);
  verify_directories();
  if (fsync(staging_fd) || fsync(directories[directory_count - 1])) failure("flush_failed");
  verify_directories();
  finish("applied", "none", 0);
  return 0;
}

static int restore_transaction(char **argv) {
  struct stat wanted = {0}, observed = {0}, parent = {0}, named;
  char value[128], relative_source[256];
  const char *name = argv[12];
  size_t length = strlen(name);
  if (length <= 10 || length > 90 || strcmp(name + length - 10, "-candidate") ||
      strspn(name, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != length)
    failure("invalid_request");
  snprintf(relative_source, sizeof(relative_source), "%s/%s", staging_name, name);
  parse_identity(argv[13], &wanted);
  parse_identity(argv[7], &parent);
  if (!same(&parent, &directory_ids[directory_count-1]) || !target_absent())
    finish("conflict", "file_version_conflict", 1);
  int source = directory_operation ? open_directory(staging_fd, name) :
    openat(staging_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (!directory_operation) {
    if (source < 0 || !supported_file(source, &observed) || !same(&observed, &wanted))
      finish("conflict", "preserved_object_changed", 1);
    wanted = observed;
  }
  if (source < 0 || (directory_operation ?
      !directory_version(source, &wanted, argv[14], &observed, value) :
      !same_version(source, 4, &wanted, argv[14])))
    finish("conflict", "preserved_object_changed", 1);
  if (directory_operation) record_directory(&observed, value);
  checkpoint("before_prepare");
  if (!directory_operation) {
    struct stat file;
    if (fstat(source, &file)) failure("preserved_object_changed");
    printf("{\"event\":\"candidate\",\"identity\":\"%ju:%ju\",\"metadata\":\"%s\",\"size\":%jd}\n",
      (uintmax_t)wanted.st_dev, (uintmax_t)wanted.st_ino, argv[14], (intmax_t)file.st_size);
    fflush(stdout);
  }
  checkpoint("before_swap");
  if (!target_absent() || fstatat(staging_fd, name, &named, AT_SYMLINK_NOFOLLOW) ||
      !same(&named, &wanted) || (directory_operation ?
      !directory_version(source, &wanted, argv[14], &observed, value) :
      !same_version(source, 4, &wanted, argv[14])))
    finish("conflict", "preserved_object_changed", 1);
  verify_directories();
  if (renameatx_np(root_fd, relative_source, root_fd, target_path,
      RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH)) {
    if (errno == EEXIST) finish("conflict", "file_version_conflict", 1);
    failure("restoration_refused");
  }
  exchanged = 1;
  checkpoint("after_swap");
  int current = open_target();
  if (current < 0 || (directory_operation ?
      !directory_version(current, &wanted, argv[14], &observed, value) :
      !same_version(current, 4, &wanted, argv[14])) ||
      fstatat(staging_fd, name, &named, AT_SYMLINK_NOFOLLOW) != -1 || errno != ENOENT)
    failure("post_restore_conflict");
  close(current); close(source);
  verify_directories();
  if (fsync(staging_fd) || fsync(directories[directory_count-1])) failure("flush_failed");
  verify_directories();
  finish("applied", "none", 0);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 15 && argc != 12 && argc != 10 && argc != 9 && argc != 8) return 64;
  root_path = argv[1]; staging_name = argv[3]; target_path = argv[5];
  int preserved_file = argc == 9 && !strcmp(argv[6], "inspect-preserved-file");
  int preserved_directory = argc == 9 && !strcmp(argv[6], "inspect-preserved-directory");
  if (preserved_file || preserved_directory) preserved_name = argv[8];
  if (argc == 9 && !preserved_name) failure("invalid_request");
  if (preserved_name && (strlen(preserved_name) > 90 || strlen(preserved_name) <= 10 || strcmp(preserved_name + strlen(preserved_name) - 10, "-candidate") || strspn(preserved_name, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != strlen(preserved_name))) failure("invalid_request");
  int restoring = argc == 15 && (!strcmp(argv[10], "restore") || !strcmp(argv[10], "restore-directory"));
  if (argc == 15 && !restoring) failure("invalid_request");
  int inspecting = (argc == 8 && !strcmp(argv[6], "inspect")) || preserved_file;
  int inspecting_absent = argc == 8 && !strcmp(argv[6], "inspect-absent");
  int listing = argc == 8 && !strcmp(argv[6], "list");
  int metadata_inspection = argc == 8 && (!strcmp(argv[6], "inspect-directory") || !strcmp(argv[6], "inspect-root-directory"));
  metadata_root = metadata_inspection && !strcmp(argv[6], "inspect-root-directory");
  int inspecting_directory = metadata_inspection || (argc == 8 && !strcmp(argv[6], "inspect-empty-directory")) || preserved_directory;
  directory_operation = (restoring && !strcmp(argv[10], "restore-directory")) || (argc == 12 && (!strcmp(argv[10], "mkdir") || !strcmp(argv[10], "rmdir") ||
    !strcmp(argv[10], "verify-mkdir") || !strcmp(argv[10], "verify-rmdir")));
  int verifying_directory = directory_operation && !strncmp(argv[10], "verify-", 7);
  creating = (argc >= 10 && !strcmp(argv[6], "absent")) ||
    (directory_operation && !strcmp(argv[10], "verify-mkdir"));
  int verifying_removal = argc == 12 && !strcmp(argv[10], "verify-remove");
  removing = argc == 12 && (!strcmp(argv[10], "remove") || verifying_removal ||
    (directory_operation && !creating));
  const char *mode_change = argc >= 12 ? argv[11] : "keep";
  int forced_mode = -1;
  if (!strncmp(mode_change, "mode-", 5)) {
    const char *value = mode_change + 5;
    if (!*value || strspn(value, "0123456789") != strlen(value)) failure("invalid_request");
    char *end = NULL;
    errno = 0;
    long mode = strtol(value, &end, 10);
    if (errno || !end || *end || mode < 0 || mode > 0777) failure("invalid_request");
    forced_mode = (int)mode;
  }
  if ((argc == 12 || argc == 15) && (
      (!restoring && !directory_operation && (creating ? strcmp(argv[10], "create") : strcmp(argv[10], "replace") && !removing)) ||
      (forced_mode < 0 && strcmp(mode_change, "keep") && strcmp(mode_change, "executable") && strcmp(mode_change, "plain")) ||
      ((removing || directory_operation) && strcmp(mode_change, "keep")) ||
      (directory_operation && !restoring && !verifying_directory &&
       (creating ? strcmp(argv[10], "mkdir") : strcmp(argv[10], "rmdir"))))) failure("invalid_request");
  if (strchr(staging_name, '/') || strcmp(staging_name, ".agora-operations") ||
      (!inspecting && !inspecting_absent && !listing && !inspecting_directory && ((argc != 10 && argc != 12 && argc != 15) ||
        strspn(argv[8], "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != strlen(argv[8]) ||
        !*argv[8] || strlen(argv[8]) > 80))) failure("invalid_request");
  pin_root(argv[2]);
  staging_fd = open_directory(root_fd, staging_name);
  if (staging_fd < 0 || fstat(staging_fd, &staging_id)) failure("root_identity_changed");
  struct stat wanted = {0};
  parse_identity(argv[4], &wanted);
  if (!same(&wanted, &staging_id) || staging_id.st_uid != getuid() ||
      (staging_id.st_mode & 0777) != 0700) failure("root_identity_changed");
  pin_parents(argv[(inspecting || inspecting_absent || listing || inspecting_directory) ? 7 : 9]);
  verify_directories();
  if (restoring) return restore_transaction(argv);
  if (directory_operation || inspecting_directory)
    return directory_transaction(argv, metadata_inspection ? 2 : inspecting_directory, verifying_directory);
  if (listing) return list_directory();
  if (verifying_removal) {
    char candidate[128];
    snprintf(candidate, sizeof(candidate), "%s-candidate", argv[8]);
    int preserved = openat(staging_fd, candidate, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    parse_identity(argv[6], &wanted);
    if (preserved < 0 || !supported_file(preserved, &expected_id) ||
        !same(&wanted, &expected_id) || !metadata(preserved, baseline_metadata) ||
        strcmp(baseline_metadata, argv[7]) ||
        !same_version(preserved, 3, &expected_id, baseline_metadata)) failure("post_remove_conflict");
    close(preserved);
    int current = open_target();
    if (current >= 0 || errno != ENOENT) failure("post_remove_conflict");
    verify_directories();
    exchanged = 1;
    finish("applied", "none", 0);
  }
  original_fd = preserved_name ? openat(staging_fd, preserved_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) : open_target();
  if (creating || inspecting_absent) {
    if (original_fd >= 0 || errno != ENOENT) finish("conflict", "file_version_conflict", 1);
    verify_directories();
    if (inspecting_absent) {
      printf("{\"parentIdentity\":\"%ju:%ju\"}\n", (uintmax_t)directory_ids[directory_count-1].st_dev, (uintmax_t)directory_ids[directory_count-1].st_ino);
      return 0;
    }
    parse_identity(argv[7], &wanted);
    if (!same(&wanted, &directory_ids[directory_count-1])) finish("conflict", "file_version_conflict", 1);
  }
  if (!creating && (original_fd < 0 || !supported_file(original_fd, &expected_id)))
    finish("conflict", "unsupported_file", 1);
  if (!creating && !metadata(original_fd, baseline_metadata)) finish("conflict", "unsupported_metadata", 1);
  if (inspecting) {
    unsigned char *content = malloc((size_t)expected_id.st_size + 1);
    if (!content) failure("read_failed");
    if (pread(original_fd, content, (size_t)expected_id.st_size + 1, 0) != expected_id.st_size)
      failure("file_version_conflict");
    struct stat after;
    char after_metadata[128];
    if (fstat(original_fd, &after) || after.st_size != expected_id.st_size ||
        after.st_mtimespec.tv_sec != expected_id.st_mtimespec.tv_sec ||
        after.st_mtimespec.tv_nsec != expected_id.st_mtimespec.tv_nsec ||
        after.st_ctimespec.tv_sec != expected_id.st_ctimespec.tv_sec ||
        after.st_ctimespec.tv_nsec != expected_id.st_ctimespec.tv_nsec ||
        !metadata(original_fd, after_metadata) || strcmp(after_metadata, baseline_metadata))
      failure("file_version_conflict");
    verify_directories();
    printf("{\"identity\":\"%ju:%ju\",\"metadata\":\"%s\",\"hex\":\"",
           (uintmax_t)expected_id.st_dev, (uintmax_t)expected_id.st_ino, baseline_metadata);
    for (off_t i = 0; i < expected_id.st_size; i++) printf("%02x", content[i]);
    puts("\"}");
    free(content);
    return 0;
  }
  if (!creating) {
    parse_identity(argv[6], &wanted);
    if (!same(&wanted, &expected_id) || strcmp(baseline_metadata, argv[7]) ||
        !same_version(original_fd, 3, &expected_id, baseline_metadata))
      finish("conflict", "file_version_conflict", 1);
  }

  checkpoint("before_prepare");
  char candidate[128], relative_candidate[256];
  snprintf(candidate, sizeof(candidate), "%s-candidate", argv[8]);
  snprintf(relative_candidate, sizeof(relative_candidate), "%s/%s", staging_name, candidate);
  if (removing) {
    struct stat occupied;
    if (!fstatat(staging_fd, candidate, &occupied, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)
      failure("candidate_unavailable");
    checkpoint("before_swap");
    int current = open_target();
    if (current < 0 || !same_version(current, 3, &expected_id, baseline_metadata))
      finish("conflict", "file_version_conflict", 1);
    close(current);
    verify_directories();
    if (renameatx_np(root_fd, target_path, root_fd, relative_candidate,
                    RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH))
      failure("quarantine_refused");
    exchanged = 1;
    checkpoint("after_swap");
    int displaced = openat(staging_fd, candidate, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (displaced < 0 || !same_version(displaced, 3, &expected_id, baseline_metadata))
      failure("post_remove_conflict");
    close(displaced);
    current = open_target();
    if (current >= 0 || errno != ENOENT) failure("post_remove_conflict");
    close(original_fd);
    verify_directories();
    if (fsync(staging_fd) || fsync(directories[directory_count - 1])) failure("flush_failed");
    verify_directories();
    finish("applied", "none", 0);
  }
  int output = openat(staging_fd, candidate, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (output < 0) failure("candidate_unavailable");
  char data[65536];
  off_t offset = 0;
  for (;;) {
    ssize_t n = pread(4, data, sizeof(data), offset);
    if (n < 0 || offset + n > FILE_CAP) failure("candidate_failed");
    if (!n) break;
    ssize_t written = 0;
    while (written < n) {
      verify_directories();
      ssize_t count = write(output, data + written, (size_t)(n - written));
      if (count <= 0) failure("candidate_failed");
      written += count;
    }
    offset += n;
  }
  verify_directories();
  if (!creating && fchown(output, expected_id.st_uid, expected_id.st_gid)) failure("candidate_failed");
  verify_directories();
  mode_t output_mode = creating ? 0644 : expected_id.st_mode & 0777;
  if (forced_mode >= 0) output_mode = (mode_t)forced_mode;
  else if (!strcmp(mode_change, "executable")) output_mode |= 0111;
  else if (!strcmp(mode_change, "plain")) output_mode &= ~0111;
  if (fchmod(output, output_mode)) failure("candidate_failed");
  verify_directories();
  if (!creating && fcopyfile(original_fd, output, NULL, COPYFILE_XATTR)) failure("candidate_failed");
  verify_directories();
  if (fsync(output)) failure("candidate_failed");
  struct stat candidate_id;
  if (!metadata(output, candidate_metadata)) failure("candidate_failed");
  if (!creating && strcmp(strchr(candidate_metadata, ':'), strchr(baseline_metadata, ':')))
    failure("candidate_metadata_changed");
  if (fstat(output, &candidate_id) || close(output) || fsync(staging_fd)) failure("candidate_failed");
  /* Persisted by the host before it acknowledges the installation checkpoint.
   * This identity is the prepared object, never a later same-name path lookup. */
  printf("{\"event\":\"candidate\",\"identity\":\"%ju:%ju\",\"metadata\":\"%s\",\"size\":%jd}\n",
         (uintmax_t)candidate_id.st_dev, (uintmax_t)candidate_id.st_ino,
         candidate_metadata, (intmax_t)candidate_id.st_size);
  fflush(stdout);
  /* No writable data descriptor survives installation into the source directory. */
  checkpoint("before_swap");
  int current = open_target();
  if (creating ? (current >= 0 || errno != ENOENT) : (current < 0 || !same_version(current, 3, &expected_id, baseline_metadata)))
    finish("conflict", "file_version_conflict", 1);
  if (current >= 0) close(current);
  verify_directories();
  if (renameatx_np(root_fd, relative_candidate, root_fd, target_path,
                  (creating ? RENAME_EXCL : RENAME_SWAP) | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH)) {
    if (creating && errno == EEXIST) finish("conflict", "file_version_conflict", 1);
    failure("exchange_refused");
  }
  exchanged = 1;
  checkpoint("after_swap");
  int displaced = creating ? -1 : openat(staging_fd, candidate, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  current = open_target();
  if ((!creating && (displaced < 0 || !same_version(displaced, 3, &expected_id, baseline_metadata))) ||
      current < 0 || !same_version(current, 4, &candidate_id, candidate_metadata)) failure("post_exchange_conflict");
  if (displaced >= 0) close(displaced);
  close(current);
  if (original_fd >= 0) close(original_fd);
  verify_directories();
  if (fsync(staging_fd) || fsync(directories[directory_count - 1])) failure("flush_failed");
  verify_directories();
  finish("applied", "none", 0);
}
