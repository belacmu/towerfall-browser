#include <emscripten/console.h>
#include <emscripten/wasmfs.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <emscripten.h>
#include <assert.h>
#include <stdint.h>
#include <unistd.h>

// OPFS (the page's private file storage) at /libsdl: game files, FortRise, saves.
int mount_opfs() {
	emscripten_console_log("mount_opfs: starting");
	backend_t opfs = wasmfs_create_opfs_backend();
	emscripten_console_log("mount_opfs: created opfs backend");
	int ret = wasmfs_create_directory("/libsdl", 0777, opfs);
	emscripten_console_log("mount_opfs: mounted opfs");
	return ret;
}

// A directory whose files are fetched over HTTP from `url` on first read. Used to expose the
// app's own assemblies (_framework/) as files, which Mono.Cecil (for MonoMod) needs.
static backend_t fetch_backend = NULL;

int mount_fetch(const char *url, const char *dir) {
	if (!fetch_backend) fetch_backend = wasmfs_create_fetch_backend(url);
	return wasmfs_create_directory(dir, 0777, fetch_backend);
}

// Fetch-backed files have to be declared before they can be opened.
int mount_fetch_file(const char *path) {
	if (!fetch_backend) return -1;
	int fd = wasmfs_create_file(path, 0777, fetch_backend);
	if (fd < 0) return fd;
	return close(fd);
}

// needed because of upstream mono bug: https://github.com/dotnet/runtime/issues/112262
void *SDL_CreateWindow(char *title, int w, int h, uint64_t flags);
void *SDL__CreateWindow(char *title, int w, int h, unsigned int flags) {
	return SDL_CreateWindow(title, w, h, (uint64_t)flags);
}
uint64_t SDL_GetWindowFlags(void *window);
uint32_t SDL__GetWindowFlags(void *window) {
	return (uint32_t)SDL_GetWindowFlags(window);
}

// Rust's standard library for Emscripten (ggrs_ffi, see tools/build-netplay.sh) imports the clock
// under its older name.
double emscripten_get_now(void);
double _emscripten_get_now(void) {
	return emscripten_get_now();
}

// MonoMod's WebAssembly interop (patches/MonoMod.patch) imports libc's close() as liba's _close.
int close(int fd);
int _close(int fd) {
	return close(fd);
}
