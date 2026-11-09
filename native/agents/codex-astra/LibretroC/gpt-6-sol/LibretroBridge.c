#include "LibretroBridge.h"
#include <dlfcn.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// All required libretro ABI entry points, including those the host does not yet call.
#define NB_SYMBOLS(X) \
    X(init) X(deinit) X(api_version) X(get_system_info) X(get_system_av_info) \
    X(set_environment) X(set_video_refresh) X(set_audio_sample) X(set_audio_sample_batch) \
    X(set_input_poll) X(set_input_state) X(set_controller_port_device) X(reset) X(run) \
    X(serialize_size) X(serialize) X(unserialize) X(cheat_reset) X(cheat_set) \
    X(load_game) X(load_game_special) X(unload_game) X(get_region) \
    X(get_memory_data) X(get_memory_size)
typedef struct {
#define NB_FIELD(name) __typeof__(&retro_##name) name;
    NB_SYMBOLS(NB_FIELD)
#undef NB_FIELD
} retro_api_t;
typedef struct nb_variable {
    char *key, *value;
    struct nb_variable *next;
} nb_variable;
static struct {
    retro_api_t api;
    bool loaded, initialized, gameLoaded, variablesUpdated;
    enum retro_pixel_format format;
    struct retro_system_av_info av;
    nb_frame frames[3];
    size_t frameCapacity;
    _Atomic uint64_t videoFrames, audioFrames;
    RingBuffer *audio;
    const uint16_t *inputPointer;
    uint16_t inputMask[2];
    char *systemDirectory, *saveDirectory;
    nb_variable *variables;
    nb_log_fn logger;
} session;

static char *copy_string(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}
static nb_variable *find_variable(const char *key) {
    if (!key) return NULL;
    for (nb_variable *v = session.variables; v; v = v->next)
        if (!strcmp(v->key, key)) return v;
    return NULL;
}
static bool store_variable(const char *key, const char *value, bool isDefault) {
    if (!key || !value) return false;
    nb_variable *v = find_variable(key);
    if (v && isDefault) return true;
    char *text = copy_string(value);
    if (!text) return false;
    if (!v) {
        v = calloc(1, sizeof(*v));
        if (!v) { free(text); return false; }
        v->key = copy_string(key);
        if (!v->key) { free(text); free(v); return false; }
        v->next = session.variables;
        session.variables = v;
    }
    free(v->value);
    v->value = text;
    if (!isDefault) session.variablesUpdated = true;
    return true;
}
bool nb_bridge_set_variable(const char *key, const char *value) {
    return store_variable(key, value, false);
}
const char *nb_bridge_get_variable(const char *key) {
    nb_variable *v = find_variable(key);
    return v ? v->value : NULL;
}
bool nb_bridge_set_directories(const char *system, const char *save) {
    char *a = copy_string(system ? system : "");
    char *b = copy_string(save ? save : "");
    if (!a || !b) { free(a); free(b); return false; }
    free(session.systemDirectory); free(session.saveDirectory);
    session.systemDirectory = a; session.saveDirectory = b;
    return true;
}
bool nb_bridge_set_geometry(const struct retro_game_geometry *g) {
    if (!g || !g->max_width || !g->max_height ||
        g->base_width > g->max_width || g->base_height > g->max_height ||
        (size_t)g->max_width > SIZE_MAX / 4 / g->max_height) return false;
    size_t size = (size_t)g->max_width * g->max_height * 4;
    if (size > session.frameCapacity) {
        uint8_t *buffers[3] = { NULL, NULL, NULL };
        for (unsigned i = 0; i < 3; ++i) {
            buffers[i] = malloc(size);
            if (!buffers[i]) {
                for (unsigned j = 0; j < 3; ++j) free(buffers[j]);
                return false;
            }
        }
        for (unsigned i = 0; i < 3; ++i) {
            free((void *)session.frames[i].data);
            session.frames[i] = (nb_frame){ .data = buffers[i], .slot = i };
        }
        session.frameCapacity = size;
    }
    session.av.geometry = *g;
    return true;
}
static void RETRO_CALLCONV bridge_log(enum retro_log_level level, const char *format, ...) {
    va_list args; va_start(args, format);
    if (!session.logger) {
        vfprintf(stderr, format, args); // no logger installed: keep core output visible
    } else {
        char message[2048];
        vsnprintf(message, sizeof(message), format, args);
        session.logger((int)level, message);
    }
    va_end(args);
}
// ~128 ms of the core's sample rate (PLAN §1.4); 64 ms target, oldest frames dropped when full.
static bool resize_audio_ring(double sampleRate) {
    size_t frames = sampleRate > 0 && sampleRate < 1e6 ? (size_t)(sampleRate * 0.128 + 0.5) : 32768;
    if (frames < 1024) frames = 1024;
    RingBuffer *ring = nb_ring_create(frames);
    if (!ring) return false;
    nb_ring_destroy(session.audio);
    session.audio = ring;
    return true;
}
static bool RETRO_CALLCONV environment(unsigned command, void *data) {
    if (!data && command != RETRO_ENVIRONMENT_GET_INPUT_BITMASKS) return false;
    switch (command) {
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *(const char **)data = session.systemDirectory; return session.systemDirectory != NULL;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *(const char **)data = session.saveDirectory; return session.saveDirectory != NULL;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        struct retro_variable *v = data;
        v->value = nb_bridge_get_variable(v->key); return v->value != NULL;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = session.variablesUpdated; session.variablesUpdated = false; return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
        for (const struct retro_variable *v = data; v->key; ++v) {
            const char *start = v->value ? strchr(v->value, ';') : NULL;
            if (!start) continue;
            while (*++start == ' ') {}
            size_t n = strcspn(start, "|");
            char *value = malloc(n + 1);
            if (!value) return false;
            memcpy(value, start, n); value[n] = 0;
            bool ok = store_variable(v->key, value, true); free(value);
            if (!ok) return false;
        }
        return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
        for (const struct retro_core_option_definition *v = data; v->key; ++v)
            if (!store_variable(v->key, v->default_value ? v->default_value : v->values[0].value, true))
                return false;
        return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: {
        const struct retro_core_options_v2 *options = data;
        if (!options->definitions) return false;
        for (const struct retro_core_option_v2_definition *v = options->definitions; v->key; ++v)
            if (!store_variable(v->key, v->default_value ? v->default_value : v->values[0].value, true))
                return false;
        return true;
    }
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: *(unsigned *)data = 2; return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        enum retro_pixel_format format = *(enum retro_pixel_format *)data;
        if (format != RETRO_PIXEL_FORMAT_0RGB1555 && format != RETRO_PIXEL_FORMAT_RGB565 &&
            format != RETRO_PIXEL_FORMAT_XRGB8888) return false;
        session.format = format; return true;
    }
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        ((struct retro_log_callback *)data)->log = bridge_log; return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY: {
        // SET_GEOMETRY only changes base dimensions/aspect; max dimensions are ignored by ABI.
        struct retro_game_geometry g = *(struct retro_game_geometry *)data;
        g.max_width = session.av.geometry.max_width;
        g.max_height = session.av.geometry.max_height;
        return nb_bridge_set_geometry(&g);
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
        const struct retro_system_av_info *av = data;
        if (!nb_bridge_set_geometry(&av->geometry)) return false;
        session.av.timing = av->timing; return true;
    }
    case RETRO_ENVIRONMENT_GET_CAN_DUPE: *(bool *)data = true; return true;
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME: return false;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
    default: return false;
    }
}
static void RETRO_CALLCONV video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
    if (!data || data == RETRO_HW_FRAME_BUFFER_VALID || !width || !height) return;
    size_t bpp = session.format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
    if (width > session.av.geometry.max_width || height > session.av.geometry.max_height ||
        (size_t)width > SIZE_MAX / bpp || pitch < (size_t)width * bpp ||
        (height > 1 && pitch > SIZE_MAX / (height - 1))) return;
    uint64_t number = atomic_load_explicit(&session.videoFrames, memory_order_relaxed) + 1;
    nb_frame *frame = &session.frames[(number - 1) % 3];
    if (!frame->data) return;
    size_t rowBytes = width * bpp;
    for (unsigned row = 0; row < height; ++row)
        memcpy((uint8_t *)frame->data + row * rowBytes, (const uint8_t *)data + row * pitch, rowBytes);
    frame->width = width; frame->height = height; frame->pitch = rowBytes;
    frame->format = session.format; frame->number = number;
    atomic_store_explicit(&session.videoFrames, number, memory_order_release);
}
static size_t RETRO_CALLCONV audio_batch(const int16_t *data, size_t frames) {
    if (!data) return 0;
    atomic_fetch_add_explicit(&session.audioFrames, frames, memory_order_relaxed);
    nb_ring_write(session.audio, data, frames);
    // Dropped frames are consumed too: a full ring must not stall a core running headless.
    return frames;
}
static void RETRO_CALLCONV audio_sample(int16_t left, int16_t right) {
    const int16_t frame[2] = { left, right }; audio_batch(frame, 1);
}
static void RETRO_CALLCONV input_poll(void) {
    for (unsigned port = 0; port < 2; ++port)
        session.inputMask[port] = session.inputPointer ?
            __atomic_load_n(&session.inputPointer[port], __ATOMIC_RELAXED) : 0;
}
static int16_t RETRO_CALLCONV input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port >= 2 || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD || index) return 0;
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)session.inputMask[port];
    return id < 16 ? (session.inputMask[port] >> id) & 1 : 0;
}
const char *nb_bridge_load(void *handle) {
    if (session.initialized) return "session already initialized";
    if (!handle) return "null dlhandle";
    retro_api_t api = {0};
#define NB_LOAD(name) do { \
    void *symbol = dlsym(handle, "retro_" #name); \
    if (!symbol) return "retro_" #name; \
    memcpy(&api.name, &symbol, sizeof(api.name)); \
} while (0);
    NB_SYMBOLS(NB_LOAD)
#undef NB_LOAD
    session.api = api; session.loaded = true;
    return NULL;
}
bool nb_bridge_init(void) {
    if (!session.loaded || session.initialized || session.api.api_version() != RETRO_API_VERSION) return false;
    session.audio = nb_ring_create(32768);
    if (!session.audio) return false;
    session.format = RETRO_PIXEL_FORMAT_0RGB1555;
    atomic_store(&session.videoFrames, 0); atomic_store(&session.audioFrames, 0);
    session.api.set_environment(environment);
    session.api.set_video_refresh(video_refresh);
    session.api.set_audio_sample(audio_sample);
    session.api.set_audio_sample_batch(audio_batch);
    session.api.set_input_poll(input_poll);
    session.api.set_input_state(input_state);
    session.initialized = true;
    session.api.init();
    return true;
}
void nb_bridge_unload_game(void) {
    if (session.gameLoaded) { session.api.unload_game(); session.gameLoaded = false; }
}
void nb_bridge_deinit(void) {
    nb_bridge_unload_game();
    if (session.initialized) session.api.deinit();
    nb_ring_destroy(session.audio);
    for (unsigned i = 0; i < 3; ++i) free((void *)session.frames[i].data);
    while (session.variables) {
        nb_variable *next = session.variables->next;
        free(session.variables->key); free(session.variables->value); free(session.variables);
        session.variables = next;
    }
    free(session.systemDirectory); free(session.saveDirectory);
    // Teardown requires audio consumer and core callbacks to have stopped.
    memset(&session, 0, sizeof(session));
    atomic_init(&session.videoFrames, 0); atomic_init(&session.audioFrames, 0);
}
unsigned nb_bridge_api_version(void) { return session.loaded ? session.api.api_version() : 0; }
void nb_bridge_system_info(struct retro_system_info *info) {
    if (session.loaded && info) session.api.get_system_info(info);
}
void nb_bridge_av_info(struct retro_system_av_info *info) { if (info) *info = session.av; }
bool nb_bridge_load_game(const struct retro_game_info *game) {
    if (!session.initialized || session.gameLoaded) return false;
    if (!session.api.load_game(game)) return false;
    session.gameLoaded = true;
    struct retro_system_av_info av = {0}; session.api.get_system_av_info(&av);
    if (!nb_bridge_set_geometry(&av.geometry)) { nb_bridge_unload_game(); return false; }
    session.av.timing = av.timing;
    // No consumer is attached yet (the host creates AudioOutput after load_game succeeds).
    if (!resize_audio_ring(av.timing.sample_rate)) { nb_bridge_unload_game(); return false; }
    session.api.set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    session.api.set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
    return true;
}
void nb_bridge_run(void) { if (session.gameLoaded) session.api.run(); }
void nb_bridge_reset(void) { if (session.gameLoaded) session.api.reset(); }
size_t nb_bridge_serialize_size(void) { return session.gameLoaded ? session.api.serialize_size() : 0; }
bool nb_bridge_serialize(void *data, size_t size) {
    return session.gameLoaded && data && session.api.serialize(data, size);
}
bool nb_bridge_unserialize(const void *data, size_t size) {
    return session.gameLoaded && data && session.api.unserialize(data, size);
}
void *nb_bridge_memory_data(unsigned id) { return session.gameLoaded ? session.api.get_memory_data(id) : NULL; }
size_t nb_bridge_memory_size(unsigned id) { return session.gameLoaded ? session.api.get_memory_size(id) : 0; }
void nb_bridge_set_input_pointer(const uint16_t *buttons) { session.inputPointer = buttons; }
void nb_bridge_set_log_fn(nb_log_fn logger) { session.logger = logger; }
RingBuffer *nb_bridge_audio_ring(void) { return session.audio; }
bool nb_bridge_latest_frame(nb_frame *frame) {
    uint64_t n = atomic_load_explicit(&session.videoFrames, memory_order_acquire);
    if (!frame || !n || !session.frames[(n - 1) % 3].number) return false;
    *frame = session.frames[(n - 1) % 3]; return true;
}
uint64_t nb_bridge_video_frames(void) { return atomic_load_explicit(&session.videoFrames, memory_order_acquire); }
uint64_t nb_bridge_audio_frames(void) { return atomic_load_explicit(&session.audioFrames, memory_order_relaxed); }
