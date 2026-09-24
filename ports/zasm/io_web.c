/*
** Web build replacement for src/io.c (same API).
**
** src/io.c maps the output file with MAP_SHARED and closes the descriptor
** right away, relying on the kernel to write the pages back. Emscripten's
** in-memory filesystem only writes shared mappings back through a still-open
** descriptor, so here the output is buffered in memory and written out when
** zasm_close() is called on it.
*/

#include "zasm.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_OUTPUTS 8

static zasm_file	g_outputs[MAX_OUTPUTS];

zasm_file zasm_input(const char *filename) {
  zasm_file f = { .name = filename };
  FILE *fp = fopen(filename, "rb");
  if (!fp) {
    perror("open");
    f.error = 1;
    return f;
  }
  fseek(fp, 0, SEEK_END);
  long len = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  f.data = malloc(len + 1);
  if (!f.data || fread(f.data, 1, len, fp) != (size_t)len) {
    perror("read");
    f.error = 1;
  } else {
    f.data[len] = 0;
    f.size = len;
  }
  fclose(fp);
  return f;
}

zasm_file zasm_output(const char *filename, size_t size) {
  zasm_file f = { .name = filename, .size = size };
  f.data = calloc(1, size);
  if (!f.data) {
    perror("calloc");
    f.error = 1;
    return f;
  }
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (!g_outputs[i].data) {
      g_outputs[i] = f;
      break;
    }
  }
  return f;
}

void zasm_close(zasm_file file) {
  for (int i = 0; i < MAX_OUTPUTS; i++) {
    if (file.data && g_outputs[i].data == file.data) {
      int fd = open(file.name, O_CREAT | O_TRUNC | O_WRONLY, 0755);
      if (fd < 0 || write(fd, file.data, file.size) != (ssize_t)file.size)
        perror("write");
      if (fd >= 0)
        close(fd);
      g_outputs[i].data = NULL;
    }
  }
  free(file.data);
}
