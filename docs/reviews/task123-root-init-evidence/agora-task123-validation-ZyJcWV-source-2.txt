/* Test-only negative capability probe followed by the production initializer. */
#define main trusted_initialization_main
#include "local-root-initialization.c"
#undef main
#include <sys/wait.h>
static int denied_open(const char *path,int flags) {
  errno=0;
  int fd=open(path,flags,0600);
  if(fd>=0){close(fd);return 0;}
  return errno==EPERM || errno==EACCES;
}
int main(int argc,char **argv) {
  if(argc!=3)return 90;
  char source[4096],external[4096];
  if(snprintf(source,sizeof(source),"%s/sentinel",argv[1])>=(int)sizeof(source))return 90;
  strcpy(external,argv[1]);char *end=strrchr(external,'/');if(!end)return 90;
  strcpy(end,"/external-secret");
  if(!denied_open(source,O_RDONLY) || !denied_open(source,O_WRONLY) ||
     !denied_open(external,O_RDONLY) || !denied_open(external,O_WRONLY))return 91;
  errno=0;pid_t child=fork();
  if(child==0)_exit(92);
  if(child>0){waitpid(child,NULL,0);return 92;}
  if(errno!=EPERM && errno!=EACCES)return 92;
  return trusted_initialization_main(argc,argv);
}
