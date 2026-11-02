#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define ROOT_PATH "/workspace"
#define MAX_PATH_BYTES 512
#define MAX_FILE_BYTES 8388608
#define MAX_ENTRIES 32

static void fail(const char *code) {
  (void)fprintf(stderr, "%s\n", code);
  exit(2);
}

static int safe_component(const char *part) {
  size_t len = strlen(part);
  if (!len || len > NAME_MAX || strcmp(part, ".") == 0 || strcmp(part, "..") == 0) return 0;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)part[i];
    if (c < 32 || c == 127 || c == '\\') return 0;
  }
  return 1;
}

static int open_parent(const char *path, char *leaf, size_t leaf_size, int create_parents) {
  if (!path || !*path || path[0] == '/' || strlen(path) > MAX_PATH_BYTES || strchr(path, '\\')) fail("invalid_path");
  char copy[MAX_PATH_BYTES + 1];
  memcpy(copy, path, strlen(path) + 1);
  int parent = open(ROOT_PATH, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (parent < 0) fail("workspace_unavailable");
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  if (!part) { close(parent); fail("invalid_path"); }
  while (part) {
    if (!safe_component(part)) { close(parent); fail("invalid_path"); }
    char *next = strtok_r(NULL, "/", &save);
    if (!next) {
      if (strlen(part) + 1 > leaf_size) { close(parent); fail("invalid_path"); }
      memcpy(leaf, part, strlen(part) + 1);
      return parent;
    }
    int child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (child < 0 && errno == ENOENT && create_parents) {
      if (mkdirat(parent, part, 0700) != 0 && errno != EEXIST) { close(parent); fail("path_not_writable"); }
      child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    }
    if (child < 0) { close(parent); fail(errno == ELOOP ? "symlink_not_allowed" : "path_not_found"); }
    close(parent);
    parent = child;
    part = next;
  }
  close(parent);
  fail("invalid_path");
  return -1;
}

static int open_directory(const char *path) {
  int current = open(ROOT_PATH, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) fail("workspace_unavailable");
  if (!path || !*path) return current;
  if (path[0] == '/' || strlen(path) > MAX_PATH_BYTES || strchr(path, '\\')) { close(current); fail("invalid_path"); }
  char copy[MAX_PATH_BYTES + 1];
  memcpy(copy, path, strlen(path) + 1);
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (!safe_component(part)) { close(current); fail("invalid_path"); }
    int child = openat(current, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (child < 0) { close(current); fail(errno == ELOOP ? "symlink_not_allowed" : "path_not_found"); }
    close(current);
    current = child;
  }
  return current;
}

static void encode_base64(const unsigned char *data, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (size_t i = 0; i < length; i += 3) {
    unsigned int a = data[i];
    unsigned int b = i + 1 < length ? data[i + 1] : 0;
    unsigned int c = i + 2 < length ? data[i + 2] : 0;
    char out[4] = {
      alphabet[a >> 2], alphabet[((a & 3) << 4) | (b >> 4)],
      i + 1 < length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=',
      i + 2 < length ? alphabet[c & 63] : '='
    };
    if (fwrite(out, 1, sizeof(out), stdout) != sizeof(out)) fail("output_failed");
  }
  (void)putchar('\n');
}

static void read_file(const char *path) {
  char leaf[NAME_MAX + 1];
  int parent = open_parent(path, leaf, sizeof(leaf), 0);
  int fd = openat(parent, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  close(parent);
  if (fd < 0) fail(errno == ELOOP ? "symlink_not_allowed" : "file_not_found");
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) { close(fd); fail("special_file_not_allowed"); }
  if (info.st_size < 0 || info.st_size > MAX_FILE_BYTES) { close(fd); fail("file_too_large"); }
  unsigned char *buffer = malloc(MAX_FILE_BYTES);
  if (!buffer) { close(fd); fail("out_of_memory"); }
  size_t used = 0;
  while (used < MAX_FILE_BYTES) {
    ssize_t got = read(fd, buffer + used, MAX_FILE_BYTES - used);
    if (got < 0) { free(buffer); close(fd); fail("file_read_failed"); }
    if (got == 0) break;
    used += (size_t)got;
  }
  unsigned char extra;
  if (read(fd, &extra, 1) != 0) { free(buffer); close(fd); fail("file_too_large"); }
  close(fd);
  encode_base64(buffer, used);
  free(buffer);
}

static void write_file(const char *path) {
  char leaf[NAME_MAX + 1];
  int parent = open_parent(path, leaf, sizeof(leaf), 1);
  struct stat existing;
  errno = 0;
  int target_stat = fstatat(parent, leaf, &existing, AT_SYMLINK_NOFOLLOW);
  if (target_stat == 0 && S_ISLNK(existing.st_mode)) {
    close(parent); fail("symlink_not_allowed");
  }
  if (target_stat != 0 && errno != ENOENT) { close(parent); fail("path_not_writable"); }
  char temp[NAME_MAX + 1];
  int fd = -1;
  for (unsigned int attempt = 0; attempt < 8 && fd < 0; attempt++) {
    unsigned long nonce = (unsigned long)getpid() * 2654435761UL + attempt;
    int n = snprintf(temp, sizeof(temp), ".mg-write-%lu.tmp", nonce);
    if (n < 0 || (size_t)n >= sizeof(temp)) { close(parent); fail("write_failed"); }
    fd = openat(parent, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0 && errno != EEXIST) { close(parent); fail("write_failed"); }
  }
  if (fd < 0) { close(parent); fail("write_failed"); }
  size_t total = 0;
  unsigned char buffer[16384];
  while (1) {
    ssize_t got = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (got < 0) { unlinkat(parent, temp, 0); close(fd); close(parent); fail("write_failed"); }
    if (got == 0) break;
    total += (size_t)got;
    if (total > MAX_FILE_BYTES) { unlinkat(parent, temp, 0); close(fd); close(parent); fail("file_too_large"); }
    size_t offset = 0;
    while (offset < (size_t)got) {
      ssize_t written = write(fd, buffer + offset, (size_t)got - offset);
      if (written <= 0) { unlinkat(parent, temp, 0); close(fd); close(parent); fail("write_failed"); }
      offset += (size_t)written;
    }
  }
  if (fsync(fd) != 0 || close(fd) != 0 || renameat(parent, temp, parent, leaf) != 0 || fsync(parent) != 0) {
    unlinkat(parent, temp, 0); close(parent); fail("write_failed");
  }
  close(parent);
  (void)printf("%zu\n", total);
}

static void json_string(const char *value) {
  (void)putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { (void)putchar('\\'); (void)putchar(*p); }
    else if (*p < 32) (void)printf("\\u%04x", (unsigned int)*p);
    else (void)putchar(*p);
  }
  (void)putchar('"');
}

static void list_files(const char *path) {
  int directory_fd = open_directory(path);
  int dupfd = dup(directory_fd);
  close(directory_fd);
  if (dupfd < 0) fail("directory_read_failed");
  DIR *directory = fdopendir(dupfd);
  if (!directory) { close(dupfd); fail("directory_read_failed"); }
  (void)putchar('[');
  size_t count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++count > MAX_ENTRIES) { closedir(directory); fail("too_many_entries"); }
    struct stat info;
    if (fstatat(dirfd(directory), entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) { closedir(directory); fail("directory_changed"); }
    if (S_ISLNK(info.st_mode)) { closedir(directory); fail("symlink_not_allowed"); }
    if (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) { closedir(directory); fail("special_file_not_allowed"); }
    if (count > 1) (void)putchar(',');
    (void)printf("{\"name\":"); json_string(entry->d_name);
    (void)printf(",\"type\":\"%s\",\"size\":%" PRIdMAX "}", S_ISDIR(info.st_mode) ? "directory" : "file", (intmax_t)info.st_size);
  }
  closedir(directory);
  (void)puts("]");
}

int main(int argc, char **argv) {
  if (argc != 3) fail("invalid_arguments");
  if (strcmp(argv[1], "read") == 0) read_file(argv[2]);
  else if (strcmp(argv[1], "write") == 0) write_file(argv[2]);
  else if (strcmp(argv[1], "list") == 0) list_files(argv[2]);
  else fail("invalid_operation");
  return 0;
}
