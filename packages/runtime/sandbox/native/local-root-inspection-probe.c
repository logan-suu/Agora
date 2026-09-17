/* Fixed negative probe: the real inspection must succeed while contents, writes
 * and process creation remain denied by the production inspection policy. */
#define main inspection_main
#include "local-root-inspection.c"
#undef main
#include <sys/wait.h>

int main(int argc,char **argv) {
  if(argc != 2) return 64;
  char source[ROOT_PATH_CAP], external[ROOT_PATH_CAP], output[ROOT_PATH_CAP];
  if(snprintf(source,sizeof(source),"%s/sentinel",argv[1]) >= (int)sizeof(source) ||
     snprintf(external,sizeof(external),"%s/../external-secret",argv[1]) >= (int)sizeof(external) ||
     snprintf(output,sizeof(output),"%s/forbidden-write",argv[1]) >= (int)sizeof(output)) return 64;
  const char *reads[]={source,external};
  for(int i=0;i<2;i++) {
    int fd=open(reads[i],O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if(fd >= 0) {close(fd);return 80+i;}
    if(errno != EPERM && errno != EACCES) return 82;
  }
  int fd=open(output,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
  if(fd >= 0) {close(fd);return 83;}
  if(errno != EPERM && errno != EACCES) return 84;
  pid_t child=fork();
  if(child == 0) _exit(85);
  if(child > 0) {waitpid(child,NULL,0);return 85;}
  if(errno != EPERM && errno != EACCES) return 86;
  return inspection_main(argc,argv);
}
