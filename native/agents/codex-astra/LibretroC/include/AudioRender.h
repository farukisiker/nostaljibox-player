#ifndef NB_AUDIO_RENDER_H
#define NB_AUDIO_RENDER_H
#include "RingBuffer.h"
#include <stdbool.h>
#include <stdint.h>
#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#endif

typedef struct NBAudioRenderer NBAudioRenderer;
NBAudioRenderer *nb_audio_renderer_create(RingBuffer *ring, double coreRate, double outputRate);
// Stop/detach the AVAudioSourceNode before destroying this state or its ring.
void nb_audio_renderer_destroy(NBAudioRenderer *state);
// reset requires the render callback to be quiescent. It does not clear the ring.
void nb_audio_renderer_reset(NBAudioRenderer *state);
void nb_audio_renderer_set_running(NBAudioRenderer *state, bool running);
// Portable planar float render entry point, also used by the Apple callback.
void nb_audio_render_stereo(NBAudioRenderer *state, uint32_t frames, float *left, float *right);
#ifdef __APPLE__
// No allocation, Objective-C/Swift objects, locks, or logging on the render thread.
int32_t nb_audio_render(NBAudioRenderer *state, uint32_t frames, AudioBufferList *buffers);
#endif
#endif
