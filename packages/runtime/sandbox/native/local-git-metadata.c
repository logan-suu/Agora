/* Read-only Git identity and tree checks through pinned directory descriptors.
 * Never run Git, follow links, or emit source/index/config bytes. */
#define _DARWIN_C_SOURCE
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>
#define DEPTH 128
#define LIMIT (16 * 1024 * 1024)
static int fds[DEPTH], count;
static struct stat identities[DEPTH];
static char names[DEPTH][256];
static int linked_mode;
static struct stat last_file_stat;
static const char *staging_expected;
static int staging_fd=-1;
static struct stat staging_stat;
static int verify_staging(void) {
  if(!staging_expected)return 1;
  struct stat actual,current;
  return staging_fd>=0 && !fstat(staging_fd,&actual) &&
    !fstatat(fds[count-1],".agora-operations",&current,AT_SYMLINK_NOFOLLOW) &&
    S_ISDIR(current.st_mode) && current.st_dev==staging_stat.st_dev && current.st_ino==staging_stat.st_ino &&
    actual.st_dev==staging_stat.st_dev && actual.st_ino==staging_stat.st_ino &&
    current.st_mode==staging_stat.st_mode && current.st_uid==staging_stat.st_uid &&
    actual.st_mode==staging_stat.st_mode && actual.st_uid==staging_stat.st_uid &&
    !(current.st_flags & SF_DATALESS) && !(actual.st_flags & SF_DATALESS);
}
static int verify(void) {
  for (int i=0;i<count;i++) {
    struct stat s;
    if ((i?fstatat(fds[i-1],names[i],&s,AT_SYMLINK_NOFOLLOW):lstat("/",&s)) ||
      !S_ISDIR(s.st_mode) || s.st_dev!=identities[i].st_dev || s.st_ino!=identities[i].st_ino ||
      s.st_mode!=identities[i].st_mode || s.st_uid!=identities[i].st_uid || (s.st_flags & SF_DATALESS)) return 0;
  }
  return 1;
}
static int append(int fd, const char *name, const char *expected) {
  struct stat s; uintmax_t dev, ino; char tail;
  if (fd<0) return 0;
  if (count>=DEPTH || strlen(name)>255 || sscanf(expected,"%ju:%ju%c",&dev,&ino,&tail)!=2 ||
    fstat(fd,&s) || !S_ISDIR(s.st_mode) || (s.st_flags & SF_DATALESS) || (uintmax_t)s.st_dev!=dev || (uintmax_t)s.st_ino!=ino) {close(fd);return 0;}
  fds[count]=fd;identities[count]=s;strcpy(names[count],name);count++;return 1;
}
/* 0 = absent, 1 = complete, -1 = rejected. Each open is relative and no-follow. */
static int file(const char *path, char digest[65], char **content) {
  if (strlen(path)>=4096 || !verify()) return -1;
  char copy[4096];strcpy(copy,path);int dir=dup(fds[count-1]);if(dir<0)return -1;
  char *part=copy;
  for (;;) {
    char *slash=strchr(part,'/');if(slash)*slash=0;
    if(!*part || !strcmp(part,".") || !strcmp(part,"..")) {close(dir);return -1;}
    if(!slash)break;
    int next=openat(dir,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(dir);
    if(next<0)return errno==ENOENT?0:-1;
    struct stat parent;
    if(fstat(next,&parent) || parent.st_dev!=identities[count-1].st_dev || (parent.st_flags & SF_DATALESS)) {close(next);return -1;}
    dir=next;part=slash+1;
  }
  if(linked_mode!=3) {
  char lock[300];if(snprintf(lock,sizeof(lock),"%s.lock",part)>=(int)sizeof(lock)){close(dir);return -1;}
  struct stat ls;if(!fstatat(dir,lock,&ls,AT_SYMLINK_NOFOLLOW)){close(dir);return -2;}
  if(errno!=ENOENT){close(dir);return -1;}
  }
  int fd=openat(dir,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);close(dir);
  if(fd<0)return errno==ENOENT?0:-1;
  struct stat a,b;
  if(fstat(fd,&a) || !S_ISREG(a.st_mode) || a.st_dev!=identities[count-1].st_dev ||
    (a.st_flags & SF_DATALESS) || a.st_nlink!=1 || a.st_size<0 || a.st_size>LIMIT) {close(fd);return -1;}
  size_t size=(size_t)a.st_size, offset=0;char *bytes=malloc(size+1);
  if(!bytes){close(fd);return -1;}
  while(offset<size){ssize_t n=read(fd,bytes+offset,size-offset);if(n<=0){free(bytes);close(fd);return -1;}offset+=(size_t)n;}
  bytes[size]=0;
  if(content && memchr(bytes,0,size)){free(bytes);close(fd);return -1;}
  int invalid=fstat(fd,&b) || b.st_nlink!=1 || b.st_size!=a.st_size || b.st_mode!=a.st_mode ||
    b.st_mtimespec.tv_sec!=a.st_mtimespec.tv_sec || b.st_mtimespec.tv_nsec!=a.st_mtimespec.tv_nsec ||
    b.st_ctimespec.tv_sec!=a.st_ctimespec.tv_sec || b.st_ctimespec.tv_nsec!=a.st_ctimespec.tv_nsec || !verify();
  close(fd);if(invalid){free(bytes);return -1;}
  unsigned char out[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes,(CC_LONG)size,out);
  for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)snprintf(digest+2*i,3,"%02x",out[i]);
  last_file_stat=b;
  if(content)*content=bytes;else free(bytes);return 1;
}
static int oid(const char *s) {
  size_t n=strlen(s);if(n!=40 && n!=64)return 0;
  for(size_t i=0;i<n;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;
  return 1;
}
static void quoted(const char *s) {
  if(!s){printf("null");return;}putchar('"');
  for(;*s;s++){if(*s=='"'||*s=='\\')putchar('\\');if((unsigned char)*s<32)printf("\\u%04x",(unsigned char)*s);else putchar(*s);}putchar('"');
}
static void trim(char *s){size_t n=strlen(s);while(n && (s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;}
static unsigned tree_entries, tree_files;
static char *tree_directories[4096];
static unsigned tree_directory_count;
static uint64_t tree_bytes;
static int tree(int fd,const char *prefix,unsigned depth) {
  if(depth>128 || !verify())return 0;
  struct stat before,after;if(fstat(fd,&before))return 0;
  int copy=dup(fd);if(copy<0)return 0;
  DIR *dir=fdopendir(copy);if(!dir){close(copy);return 0;}
  struct dirent *entry;int valid=1;
  for(;;){errno=0;entry=readdir(dir);if(!entry){if(errno)valid=0;break;}
    const char *name=entry->d_name;
    if(!strcmp(name,".")||!strcmp(name,".."))continue;
    if(!*prefix && !strcmp(name,".git"))continue;
    if(!*prefix && !strcmp(name,".agora-operations") && staging_expected) {
      uintmax_t dev,ino;char tail;
      if(staging_fd>=0 || sscanf(staging_expected,"%ju:%ju%c",&dev,&ino,&tail)!=2) {valid=0;break;}
      staging_fd=openat(fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      if(staging_fd<0 || fstat(staging_fd,&staging_stat) || !S_ISDIR(staging_stat.st_mode) ||
        (staging_stat.st_mode & 0777)!=0700 || staging_stat.st_uid!=getuid() ||
        staging_stat.st_dev!=identities[count-1].st_dev || (staging_stat.st_flags & SF_DATALESS) ||
        (uintmax_t)staging_stat.st_dev!=dev || (uintmax_t)staging_stat.st_ino!=ino || !verify_staging()) {valid=0;break;}
      continue;
    }
    if(++tree_entries>4096 || !strcasecmp(name,".git") || !strcasecmp(name,".env") ||
       !strncasecmp(name,".env.",5) || !strcasecmp(name,".agora-operations")){valid=0;break;}
    char path[4096];if(snprintf(path,sizeof(path),"%s%s%s",prefix,*prefix?"/":"",name)>=(int)sizeof(path)){valid=0;break;}
    struct stat s;if(fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW) ||
      s.st_dev!=identities[count-1].st_dev || (s.st_flags & SF_DATALESS)){valid=0;break;}
    if(S_ISDIR(s.st_mode)) {
      int child=openat(fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      struct stat actual,current;
      if(child<0){valid=0;break;}
      int ok=!fstat(child,&actual) && actual.st_dev==s.st_dev && actual.st_ino==s.st_ino && tree(child,path,depth+1);
      close(child);
      if(!ok || fstatat(fd,name,&current,AT_SYMLINK_NOFOLLOW) || !S_ISDIR(current.st_mode) ||
        current.st_dev!=s.st_dev || current.st_ino!=s.st_ino){valid=0;break;}
      if(tree_directory_count>=4096 || !(tree_directories[tree_directory_count]=strdup(path))){valid=0;break;}
      tree_directory_count++;
    } else {
      char digest[65];if(!S_ISREG(s.st_mode)||file(path,digest,NULL)!=1){valid=0;break;}
      tree_bytes+=(uint64_t)last_file_stat.st_size;
      if(tree_bytes>256*1024*1024){valid=0;break;}
      if(tree_files++)putchar(',');printf("{\"path\":");quoted(path);printf(",\"sha256\":");quoted(digest);
      printf(",\"size\":%jd,\"executable\":%s}",(intmax_t)last_file_stat.st_size,(last_file_stat.st_mode&0111)?"true":"false");
    }
  }
  closedir(dir);
  return valid && !fstat(fd,&after) && before.st_dev==after.st_dev && before.st_ino==after.st_ino &&
    before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec &&
    before.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec && verify();
}
static int inspect(int argc,char **argv) {
  if(argc<3 || argv[1][0]!='/' || strlen(argv[1])>=4096)return 64;
  if(!append(open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"",argv[2]))return 65;
  char copy[4096];strcpy(copy,argv[1]+1);char *part=copy;
  for(;;){char *slash=strchr(part,'/');if(slash)*slash=0;
    if(argc<=count+2 || !*part || !strcmp(part,".") || !strcmp(part,"..") ||
      !append(openat(fds[count-1],part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),part,argv[count+2]))return 65;
    if(!slash)break;part=slash+1;
  }
  if(argc!=count+2)return 64;
  struct statfs fs;if(fstatfs(fds[count-1],&fs)||strcmp(fs.f_fstypename,"apfs")||!(fs.f_flags&MNT_LOCAL))return 65;
  if(linked_mode==3) {
    printf("{\"schemaVersion\":\"local-git-tree-v2\",\"files\":[");
    if(!tree(fds[count-1],"",0) || !verify_staging())return 65;
    printf("],\"directories\":[");
    for(unsigned i=0;i<tree_directory_count;i++){if(i)putchar(',');quoted(tree_directories[i]);}
    printf("],\"entryCount\":%u}\n",tree_entries);return 0;
  }
  if(linked_mode) {
    const char *paths[]={linked_mode==1?".git":"HEAD","commondir","gitdir","index"};
    const char *keys[]={linked_mode==1?"marker":"head","commonDir","gitDir","indexHash"};
    int length=linked_mode==1?1:4;
    char *values[4]={0};char hashes[4][65]={{0}};
    for(int i=0;i<length;i++) {
      int status=file(paths[i],hashes[i],i==3?NULL:&values[i]);
      if(status<0 || (i!=3 && status!=1)) return status==-2?67:65;
      if(values[i]) {if(strlen(values[i])>4096)return 65;trim(values[i]);}
      if(i==3 && status==1)values[i]=strdup(hashes[i]);
    }
    if(!verify())return 65;
    printf("{\"schemaVersion\":\"local-git-linked-v1\"");
    for(int i=0;i<length;i++){printf(",\"%s\":",keys[i]);quoted(values[i]);free(values[i]);}
    puts("}");return 0;
  }
  const char *keys[]={"headHash","indexHash","configHash","packedRefsHash","refHash"};
  const char *paths[]={"HEAD","index","config","packed-refs"};
  char hashes[5][65]={{0}};int present[5]={0};char *head=NULL,*packed=NULL,*ref=NULL;
  for(int i=0;i<4;i++){
    present[i]=file(paths[i],hashes[i],i==0?&head:i==3?&packed:NULL);
    if(present[i]<0)return present[i]==-2?67:65;
    if((i==0||i==2)&&!present[i])return 65;
  }
  trim(head);char *symbol=NULL,*commit=NULL;
  if(!strncmp(head,"ref: refs/heads/",16)) {
    symbol=head+5;if(strlen(symbol)>1024)return 65;
    present[4]=file(symbol,hashes[4],&ref);if(present[4]<0)return present[4]==-2?67:65;
    if(ref){trim(ref);commit=ref;}
    else if(packed){char *line=packed;while(*line){char *end=strchr(line,'\n');if(end)*end=0;
      char *space=strchr(line,' ');if(space && !strcmp(space+1,symbol)){*space=0;commit=line;break;}
      if(!end)break;line=end+1;
    }}
  } else commit=head;
  if((commit&&!oid(commit))||!verify())return 65;
  printf("{\"schemaVersion\":\"local-git-metadata-v1\"");
  for(int i=0;i<5;i++){printf(",\"%s\":",keys[i]);quoted(present[i]?hashes[i]:NULL);}
  printf(",\"symbolicRef\":");quoted(symbol);printf(",\"commit\":");quoted(commit);puts("}");
  free(head);free(packed);free(ref);return 0;
}
int main(int argc,char **argv){
  if(argc>2 && !strcmp(argv[1],"--tree-with-staging")) {
    linked_mode=3;staging_expected=argv[2];argc-=2;argv+=2;
  } else if(argc>1 && (!strcmp(argv[1],"--marker") || !strcmp(argv[1],"--linked") || !strcmp(argv[1],"--tree"))) {
    linked_mode=!strcmp(argv[1],"--marker")?1:!strcmp(argv[1],"--linked")?2:3;argc--;argv++;
  }
  int result=inspect(argc,argv);for(unsigned i=0;i<tree_directory_count;i++)free(tree_directories[i]);if(staging_fd>=0)close(staging_fd);for(int i=count-1;i>=0;i--)close(fds[i]);return result;
}
