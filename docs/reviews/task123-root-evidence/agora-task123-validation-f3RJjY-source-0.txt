/* Read-only root inspection. No project code, directory creation or grant.
 * All components are opened without following links and revalidated before output.
 */
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define ROOT_PATH_CAP 4096
#define ROOT_DEPTH_CAP 128
static int fds[ROOT_DEPTH_CAP], count;
static struct stat identities[ROOT_DEPTH_CAP];
static char names[ROOT_DEPTH_CAP][256];
static int append(int fd, const char *name) {
  if (fd < 0 || count >= ROOT_DEPTH_CAP || strlen(name) >= sizeof(names[0])) return 0;
  struct stat info;
  if (fstat(fd, &info) || !S_ISDIR(info.st_mode) || (info.st_flags & SF_DATALESS)) {close(fd);return 0;}
  fds[count]=fd; identities[count]=info; strcpy(names[count],name);count++;
  return 1;
}
static int inspect(const char *path) {
  if (path[0] != '/' || !path[1] || strlen(path) >= ROOT_PATH_CAP) return 64;
  char copy[ROOT_PATH_CAP];strcpy(copy,path+1);
  if (!append(open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"")) return 65;
  char *cursor=copy;
  for (;;) {
    char *slash=strchr(cursor,'/');
    if (slash) *slash=0;
    if (!*cursor || !strcmp(cursor,".") || !strcmp(cursor,"..")) return 64;
    if (!append(openat(fds[count-1],cursor,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),cursor)) return 65;
    if (!slash) break;
    cursor=slash+1;
  }
  int root=fds[count-1];
  struct statfs fs;
  if (fstatfs(root,&fs)) {fprintf(stderr,"statfs_errno:%d\n",errno);return 66;}
  if (strcmp(fs.f_fstypename,"apfs") || !(fs.f_flags & MNT_LOCAL)) {fprintf(stderr,"filesystem_rejected:%s:%u\n",fs.f_fstypename,fs.f_flags);return 66;}
  struct attrlist attrs={0};
  attrs.bitmapcount=ATTR_BIT_MAP_COUNT;
  attrs.volattr=ATTR_VOL_INFO|ATTR_VOL_UUID;
  struct {uint32_t length; unsigned char bytes[16];} volume={0};
  if (fgetattrlist(root,&attrs,&volume,sizeof(volume),0)) {fprintf(stderr,"getattr_errno:%d\n",errno);return 66;}
  if (volume.length != sizeof(volume)) {fprintf(stderr,"getattr_length:%u:%zu\n",volume.length,sizeof(volume));return 66;}
  int nonzero=0;
  for (int i=0;i<16;i++) nonzero |= volume.bytes[i];
  if (!nonzero) {fprintf(stderr,"volume_uuid_absent\n");return 66;}
  for (int i=0;i<count;i++) {
    struct stat observed;
    int result = i ? fstatat(fds[i-1],names[i],&observed,AT_SYMLINK_NOFOLLOW) : lstat("/",&observed);
    if (result || !S_ISDIR(observed.st_mode) || observed.st_dev != identities[i].st_dev || observed.st_ino != identities[i].st_ino || observed.st_uid != identities[i].st_uid || observed.st_mode != identities[i].st_mode || (observed.st_flags & SF_DATALESS)) return 65;
  }
  printf("{\"schemaVersion\":\"local-root-inspection-v1\",\"filesystem\":\"apfs\",\"local\":true,\"volumeId\":\"");
  for(int i=0;i<16;i++) printf("%02x",volume.bytes[i]);
  printf("\",\"chain\":[");
  for(int i=0;i<count;i++) printf("%s{\"identity\":\"%ju:%ju\",\"uid\":%u,\"mode\":%u}",i?",":"",(uintmax_t)identities[i].st_dev,(uintmax_t)identities[i].st_ino,identities[i].st_uid,identities[i].st_mode);
  puts("]}");
  return 0;
}
int main(int argc,char **argv) {
  if(argc != 2) return 64;
  int result=inspect(argv[1]);
  for(int i=count-1;i>=0;i--) close(fds[i]);
  return result;
}
