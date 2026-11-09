#ifndef NB_RING_BUFFER_H
#define NB_RING_BUFFER_H
#include <stddef.h>
#include <stdint.h>

typedef struct RingBuffer RingBuffer;
// Stereo interleaved int16 samples. Counts and capacity are in frames, not samples.
// One producer and one consumer; destroy/clear require both to be quiescent.
RingBuffer *nb_ring_create(size_t capacityFrames);
void nb_ring_destroy(RingBuffer *ring);
// Always stores the newest frames; when the ring is full the OLDEST frames are dropped
// (counted in overflows). Returns the number of frames stored (frames, capped at capacity).
size_t nb_ring_write(RingBuffer *ring, const int16_t *samples, size_t frames);
// Zero-fills missing samples, but returns only the frames actually read.
size_t nb_ring_read(RingBuffer *ring, int16_t *samples, size_t frames);
size_t nb_ring_fill(const RingBuffer *ring);
void nb_ring_clear(RingBuffer *ring);
// Counters measure missing/dropped frames, and persist across clear().
uint64_t nb_ring_underruns(const RingBuffer *ring);
uint64_t nb_ring_overflows(const RingBuffer *ring);
#endif
