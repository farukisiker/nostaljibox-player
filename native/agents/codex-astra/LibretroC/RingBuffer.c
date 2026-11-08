#include "RingBuffer.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct RingBuffer {
    int16_t *samples;
    size_t capacity;
    _Atomic size_t readIndex, writeIndex;
    _Atomic uint64_t underruns, overflows;
};

RingBuffer *nb_ring_create(size_t capacityFrames) {
    if (!capacityFrames || capacityFrames > SIZE_MAX / (2 * sizeof(int16_t))) return NULL;
    RingBuffer *r = calloc(1, sizeof(*r));
    if (!r) return NULL;
    r->samples = calloc(capacityFrames, 2 * sizeof(int16_t));
    if (!r->samples) { free(r); return NULL; }
    r->capacity = capacityFrames;
    atomic_init(&r->readIndex, 0);
    atomic_init(&r->writeIndex, 0);
    atomic_init(&r->underruns, 0);
    atomic_init(&r->overflows, 0);
    if (!atomic_is_lock_free(&r->readIndex) || !atomic_is_lock_free(&r->underruns)) {
        nb_ring_destroy(r); return NULL;
    }
    return r;
}
void nb_ring_destroy(RingBuffer *r) { if (r) { free(r->samples); free(r); } }
size_t nb_ring_write(RingBuffer *r, const int16_t *samples, size_t frames) {
    if (!r || !samples) return 0;
    size_t w = atomic_load_explicit(&r->writeIndex, memory_order_relaxed);
    size_t used = w - atomic_load_explicit(&r->readIndex, memory_order_acquire);
    size_t count = frames < r->capacity - used ? frames : r->capacity - used;
    for (size_t i = 0; i < count; ++i) {
        size_t slot = (w + i) % r->capacity;
        r->samples[slot * 2] = samples[i * 2];
        r->samples[slot * 2 + 1] = samples[i * 2 + 1];
    }
    atomic_store_explicit(&r->writeIndex, w + count, memory_order_release);
    atomic_fetch_add_explicit(&r->overflows, frames - count, memory_order_relaxed);
    return count;
}
size_t nb_ring_read(RingBuffer *r, int16_t *samples, size_t frames) {
    if (!r || !samples || frames > SIZE_MAX / (2 * sizeof(int16_t))) return 0;
    size_t rd = atomic_load_explicit(&r->readIndex, memory_order_relaxed);
    size_t available = atomic_load_explicit(&r->writeIndex, memory_order_acquire) - rd;
    size_t count = frames < available ? frames : available;
    for (size_t i = 0; i < count; ++i) {
        size_t slot = (rd + i) % r->capacity;
        samples[i * 2] = r->samples[slot * 2];
        samples[i * 2 + 1] = r->samples[slot * 2 + 1];
    }
    memset(samples + count * 2, 0, (frames - count) * 2 * sizeof(int16_t));
    atomic_store_explicit(&r->readIndex, rd + count, memory_order_release);
    atomic_fetch_add_explicit(&r->underruns, frames - count, memory_order_relaxed);
    return count;
}
size_t nb_ring_fill(const RingBuffer *r) {
    if (!r) return 0;
    size_t rd = atomic_load_explicit(&r->readIndex, memory_order_acquire);
    size_t count = atomic_load_explicit(&r->writeIndex, memory_order_acquire) - rd;
    return count < r->capacity ? count : r->capacity;
}
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
