#include "../include/RingBuffer.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct RingBuffer {
    // One atomic value per stereo frame prevents a concurrent overflow from tearing a pair.
    _Atomic uint32_t *samples;
    size_t capacity;
    _Atomic size_t readIndex, writeIndex;
    _Atomic uint64_t underruns, overflows;
};

static uint32_t pack_frame(const int16_t *samples) {
    return (uint32_t)(uint16_t)samples[0] |
           ((uint32_t)(uint16_t)samples[1] << 16);
}

static void unpack_frame(uint32_t frame, int16_t *samples) {
    uint16_t left = (uint16_t)frame;
    uint16_t right = (uint16_t)(frame >> 16);
    memcpy(&samples[0], &left, sizeof(left));
    memcpy(&samples[1], &right, sizeof(right));
}

RingBuffer *nb_ring_create(size_t capacityFrames) {
    if (!capacityFrames || capacityFrames > SIZE_MAX / (2 * sizeof(int16_t)) ||
        capacityFrames > SIZE_MAX / sizeof(_Atomic uint32_t)) return NULL;
    RingBuffer *r = calloc(1, sizeof(*r));
    if (!r) return NULL;
    r->samples = calloc(capacityFrames, sizeof(*r->samples));
    if (!r->samples) { free(r); return NULL; }
    r->capacity = capacityFrames;
    for (size_t i = 0; i < capacityFrames; ++i) atomic_init(&r->samples[i], 0);
    atomic_init(&r->readIndex, 0);
    atomic_init(&r->writeIndex, 0);
    atomic_init(&r->underruns, 0);
    atomic_init(&r->overflows, 0);
    if (!atomic_is_lock_free(&r->samples[0]) ||
        !atomic_is_lock_free(&r->readIndex) ||
        !atomic_is_lock_free(&r->underruns)) {
        nb_ring_destroy(r); return NULL;
    }
    return r;
}

void nb_ring_destroy(RingBuffer *r) { if (r) { free(r->samples); free(r); } }

size_t nb_ring_write(RingBuffer *r, const int16_t *samples, size_t frames) {
    if (!r || !samples || frames > SIZE_MAX / (2 * sizeof(int16_t))) return 0;
    size_t dropped = 0;
    if (frames > r->capacity) {
        dropped = frames - r->capacity;
        samples += dropped * 2;
        frames = r->capacity;
    }
    size_t w = atomic_load_explicit(&r->writeIndex, memory_order_relaxed);
    size_t rd = atomic_load_explicit(&r->readIndex, memory_order_acquire);
    for (;;) {
        size_t used = w - rd;
        if (used > r->capacity) used = r->capacity;
        if (frames <= r->capacity - used) break;
        size_t drop = frames - (r->capacity - used);
        if (atomic_compare_exchange_weak_explicit(&r->readIndex, &rd, rd + drop,
                                                  memory_order_acq_rel, memory_order_acquire)) {
            dropped += drop;
            break;
        }
    }
    for (size_t i = 0; i < frames; ++i) {
        size_t slot = (w + i) % r->capacity;
        atomic_store_explicit(&r->samples[slot], pack_frame(samples + i * 2), memory_order_relaxed);
    }
    atomic_store_explicit(&r->writeIndex, w + frames, memory_order_release);
    if (dropped) atomic_fetch_add_explicit(&r->overflows, dropped, memory_order_relaxed);
    return frames;
}

size_t nb_ring_read(RingBuffer *r, int16_t *samples, size_t frames) {
    if (!r || !samples || frames > SIZE_MAX / (2 * sizeof(int16_t))) return 0;
    size_t count = 0;
    // An overflow may invalidate a copied candidate. Bound retries for the audio callback.
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        size_t rd = atomic_load_explicit(&r->readIndex, memory_order_acquire);
        size_t w = atomic_load_explicit(&r->writeIndex, memory_order_acquire);
        size_t available = w - rd;
        if (rd > w || available > r->capacity) available = 0;
        count = frames < available ? frames : available;
        for (size_t i = 0; i < count; ++i) {
            size_t slot = (rd + i) % r->capacity;
            unpack_frame(atomic_load_explicit(&r->samples[slot], memory_order_relaxed), samples + i * 2);
        }
        if (!count) {
            if (atomic_load_explicit(&r->readIndex, memory_order_acquire) == rd) break;
        } else if (atomic_compare_exchange_weak_explicit(&r->readIndex, &rd, rd + count,
                                                          memory_order_acq_rel, memory_order_acquire)) {
            break;
        }
        count = 0;
    }
    memset(samples + count * 2, 0, (frames - count) * 2 * sizeof(int16_t));
    atomic_fetch_add_explicit(&r->underruns, frames - count, memory_order_relaxed);
    return count;
}

size_t nb_ring_fill(const RingBuffer *r) {
    if (!r) return 0;
    size_t rd = atomic_load_explicit(&r->readIndex, memory_order_acquire);
    size_t w = atomic_load_explicit(&r->writeIndex, memory_order_acquire);
    if (rd > w) return 0;
    size_t count = w - rd;
    return count < r->capacity ? count : r->capacity;
}

// The caller must stop both threads before clear, as documented in the public header.
void nb_ring_clear(RingBuffer *r) {
    if (!r) return;
    atomic_store_explicit(&r->readIndex, 0, memory_order_relaxed);
    atomic_store_explicit(&r->writeIndex, 0, memory_order_relaxed);
}

uint64_t nb_ring_underruns(const RingBuffer *r) {
    return r ? atomic_load_explicit(&r->underruns, memory_order_relaxed) : 0;
}
uint64_t nb_ring_overflows(const RingBuffer *r) {
    return r ? atomic_load_explicit(&r->overflows, memory_order_relaxed) : 0;
}
