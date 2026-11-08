#ifndef NB_LIBRETRO_BRIDGE_H
#define NB_LIBRETRO_BRIDGE_H
#include "libretro.h"
#include "RingBuffer.h"

typedef void (*nb_log_fn)(int level, const char *message);
typedef struct nb_frame {
    const uint8_t *data;
    unsigned width, height;
    size_t pitch;
    enum retro_pixel_format format;
    uint64_t number;
    unsigned slot;
} nb_frame;

// Single session. All operations except ring consumption/counters run on the core thread.
// load returns NULL on success, otherwise the missing symbol's name (or an error).
const char *nb_bridge_load(void *dlhandle);
bool nb_bridge_init(void);
void nb_bridge_deinit(void);
unsigned nb_bridge_api_version(void);
void nb_bridge_system_info(struct retro_system_info *info);
void nb_bridge_av_info(struct retro_system_av_info *info);
bool nb_bridge_load_game(const struct retro_game_info *game);
void nb_bridge_unload_game(void);
void nb_bridge_run(void);
void nb_bridge_reset(void);
size_t nb_bridge_serialize_size(void);
bool nb_bridge_serialize(void *data, size_t size);
bool nb_bridge_unserialize(const void *data, size_t size);
void *nb_bridge_memory_data(unsigned id);
size_t nb_bridge_memory_size(unsigned id);
bool nb_bridge_set_directories(const char *system, const char *save);
bool nb_bridge_set_variable(const char *key, const char *value);
const char *nb_bridge_get_variable(const char *key);
// Pointer must stay alive until unset, be 16-bit aligned, and hold a single-copy atomic mask.
void nb_bridge_set_input_pointer(const uint16_t *buttons);
void nb_bridge_set_log_fn(nb_log_fn logger);
RingBuffer *nb_bridge_audio_ring(void);
bool nb_bridge_set_geometry(const struct retro_game_geometry *geometry);
// Read/copy on core thread before the next run or geometry change. This is NOT a GPU lease.
bool nb_bridge_latest_frame(nb_frame *frame);
uint64_t nb_bridge_video_frames(void);
uint64_t nb_bridge_audio_frames(void);
#endif
