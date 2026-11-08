#include "AudioRender.h"
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct NBAudioRenderer {
    RingBuffer *ring;
    double baseRatio, targetFrames, phase;
    int16_t previous[2], next[2];
    bool primed;
    _Atomic bool running;
};

NBAudioRenderer *nb_audio_renderer_create(RingBuffer *ring, double coreRate, double outputRate) {
    if (!ring || !isfinite(coreRate) || !isfinite(outputRate) ||
        coreRate < 1000 || outputRate < 1000 || coreRate > 384000 || outputRate > 384000) return NULL;
    NBAudioRenderer *state = calloc(1, sizeof(*state));
    if (!state) return NULL;
    state->ring = ring;
    state->baseRatio = coreRate / outputRate;
    state->targetFrames = coreRate * 0.064;
    atomic_init(&state->running, false);
    return state;
}
void nb_audio_renderer_destroy(NBAudioRenderer *state) { free(state); }
void nb_audio_renderer_reset(NBAudioRenderer *state) {
    if (!state) return;
    state->phase = 0; state->primed = false;
    memset(state->previous, 0, sizeof(state->previous));
    memset(state->next, 0, sizeof(state->next));
}
void nb_audio_renderer_set_running(NBAudioRenderer *state, bool running) {
    if (state) atomic_store_explicit(&state->running, running, memory_order_release);
}
void nb_audio_render_stereo(NBAudioRenderer *state, uint32_t frames, float *left, float *right) {
    if (!left || !right) return;
    if (!state || !atomic_load_explicit(&state->running, memory_order_acquire)) {
        memset(left, 0, (size_t)frames * sizeof(float));
        memset(right, 0, (size_t)frames * sizeof(float));
        return;
    }
    double skew = ((double)nb_ring_fill(state->ring) - state->targetFrames) / state->targetFrames * 0.005;
    if (skew < -0.005) skew = -0.005;
    if (skew > 0.005) skew = 0.005;
    double ratio = state->baseRatio * (1 + skew);
    if (!state->primed) {
        nb_ring_read(state->ring, state->previous, 1);
        nb_ring_read(state->ring, state->next, 1);
        state->primed = true;
    }
    for (uint32_t i = 0; i < frames; ++i) {
        left[i] = (float)((state->previous[0] + (state->next[0] - state->previous[0]) * state->phase) / 32768.0);
        right[i] = (float)((state->previous[1] + (state->next[1] - state->previous[1]) * state->phase) / 32768.0);
        state->phase += ratio;
        while (state->phase >= 1) {
            state->phase -= 1;
            state->previous[0] = state->next[0];
            state->previous[1] = state->next[1];
            nb_ring_read(state->ring, state->next, 1);
        }
    }
}
#ifdef __APPLE__
int32_t nb_audio_render(NBAudioRenderer *state, uint32_t frames, AudioBufferList *buffers) {
    if (!buffers) return 0;
    // The source is configured for Float32, stereo, non-interleaved output.
    if (buffers->mNumberBuffers == 2 && buffers->mBuffers[0].mNumberChannels == 1 &&
        buffers->mBuffers[1].mNumberChannels == 1 &&
        buffers->mBuffers[0].mDataByteSize >= (size_t)frames * sizeof(float) &&
        buffers->mBuffers[1].mDataByteSize >= (size_t)frames * sizeof(float) &&
        buffers->mBuffers[0].mData && buffers->mBuffers[1].mData) {
        nb_audio_render_stereo(state, frames, buffers->mBuffers[0].mData, buffers->mBuffers[1].mData);
    } else {
        for (uint32_t i = 0; i < buffers->mNumberBuffers; ++i)
            if (buffers->mBuffers[i].mData) memset(buffers->mBuffers[i].mData, 0, buffers->mBuffers[i].mDataByteSize);
    }
    return 0;
}
#endif
