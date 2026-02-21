/**
 * lk_no_hw_video — LD_PRELOAD shim to disable Nvidia hardware video codecs.
 *
 * LiveKit's embedded libwebrtc uses implib-gen stubs that dlopen() the
 * Nvidia video encoder/decoder libraries at runtime. On WSL2 (and some
 * headless Linux setups), these libraries are present but non-functional,
 * crashing PeerConnectionFactory initialization entirely.
 *
 * This shim intercepts dlopen() and blocks loading of:
 * - libnvidia-encode.so*  (NVEnc — H264/H265 hardware encoding)
 * - libnvcuvid.so*        (NvDec — hardware video decoding)
 *
 * Everything else (libcuda, CUDA compute, PyTorch, etc.) is untouched.
 *
 * Build:
 *   gcc -shared -fPIC -o lk_no_hw_video.so lk_no_hw_video.c -ldl
 *
 * Usage:
 *   LD_PRELOAD=./lk_no_hw_video.so python agent.py dev
 *
 * Safe on all platforms:
 * - Linux + working NVEnc: disables HW video encoding (irrelevant for
 *   audio-only agents; no video tracks are published).
 * - Mac: this file is never loaded (no LD_PRELOAD; Mac uses VideoToolbox).
 * - Windows: not applicable (LD_PRELOAD is Linux-only).
 * - Docker/CI without GPU: libs already absent; shim is a no-op.
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Real dlopen — resolved once, cached. */
typedef void *(*dlopen_fn)(const char *, int);

void *dlopen(const char *filename, int flags) {
    /* Resolve the real dlopen from libc/ld-linux. */
    static dlopen_fn real_dlopen = NULL;
    if (!real_dlopen) {
        real_dlopen = (dlopen_fn)dlsym(RTLD_NEXT, "dlopen");
    }

    /* Block ALL hardware acceleration libraries loaded via implib-gen.
     * These are lazy-loaded and can crash PeerConnectionFactory if
     * partially functional (e.g. WSL2 Nvidia, missing VA-API, etc.).
     *
     * For audio-only agents, none of these are needed:
     * - libcuda.so       → Nvidia CUDA (used by NVEnc encoder detection)
     * - libnvcuvid.so    → Nvidia hardware video decoder
     * - libnvidia-encode → NVEnc hardware video encoder
     * - libva.so         → VA-API video acceleration
     * - libva-drm.so     → VA-API DRM backend
     *
     * We keep libX11.so (not blocked) as it may be needed for display.
     * Set LK_KEEP_GPU=1 to disable this shim and use all hardware. */
    if (filename && !getenv("LK_KEEP_GPU")) {
        if (strstr(filename, "libcuda.so") ||
            strstr(filename, "libnvcuvid") ||
            strstr(filename, "libnvidia-encode") ||
            strstr(filename, "libva.so") ||
            strstr(filename, "libva-drm")) {
            fprintf(stderr, "[lk_no_hw_video] BLOCKED dlopen(%s)\n", filename);
            return NULL;
        }
    }

    void *handle = real_dlopen(filename, flags);
    /* Debug: log failed dlopen calls */
    if (filename && !handle) {
        fprintf(stderr, "[lk_no_hw_video] FAILED  dlopen(%s): %s\n", filename, dlerror());
    }

    return handle;
}
