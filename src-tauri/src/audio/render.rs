use rtrb::Consumer;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc,
};

/// One decoded stereo source frame tagged with the playback generation that owns it.
#[derive(Debug, Clone, Copy)]
pub struct QueuedFrame {
    pub generation: u64,
    pub source_frame: u64,
    pub left: f32,
    pub right: f32,
}

/// Atomics shared by the non-real-time controller and the audio callback.
pub struct RenderState {
    pub generation: AtomicU64,
    pub source_frame: AtomicU64,
    pub playing: AtomicBool,
    pub volume_bits: AtomicU32,
    pub underruns: AtomicU64,
    /// Set by CPAL's error callback using a single bounded atomic store.
    pub stream_error: AtomicBool,
}

impl RenderState {
    pub const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            source_frame: AtomicU64::new(0),
            playing: AtomicBool::new(false),
            volume_bits: AtomicU32::new(1.0_f32.to_bits()),
            underruns: AtomicU64::new(0),
            stream_error: AtomicBool::new(false),
        }
    }

    pub fn set_volume(&self, volume: f32) {
        let safe_volume = if volume.is_finite() {
            volume.max(0.0)
        } else {
            0.0
        };
        self.volume_bits
            .store(safe_volume.to_bits(), Ordering::Release);
    }
}

impl Default for RenderState {
    fn default() -> Self {
        Self::new()
    }
}

/// A pure, allocation-free callback core for a fixed-capacity `rtrb` consumer.
///
/// A render call discards at most `stale_scan_limit` frames for each device frame. That limit is
/// captured from the ring capacity at construction, so a concurrent producer cannot turn stale
/// generation draining into unbounded callback work.
pub struct RenderCore {
    consumer: Consumer<QueuedFrame>,
    state: Arc<RenderState>,
    stale_scan_limit: usize,
}

impl RenderCore {
    pub fn new(consumer: Consumer<QueuedFrame>, state: Arc<RenderState>) -> Self {
        let stale_scan_limit = consumer.buffer().capacity();
        Self {
            consumer,
            state,
            stale_scan_limit,
        }
    }

    /// Fills interleaved device samples without allocating, locking, decoding, or performing I/O.
    pub fn fill_f32(&mut self, output: &mut [f32], output_channels: usize) {
        if output_channels == 0 {
            output.fill(0.0);
            return;
        }

        for device_frame in output.chunks_mut(output_channels) {
            if !self.state.playing.load(Ordering::Acquire) {
                device_frame.fill(0.0);
                continue;
            }

            let generation = self.state.generation.load(Ordering::Acquire);
            let frame = self.take_active_frame(generation);
            if let Some(frame) = frame {
                let volume = self.volume();
                for (channel, sample) in device_frame.iter_mut().enumerate() {
                    let source_sample = if channel == 0 {
                        frame.left
                    } else {
                        frame.right
                    };
                    *sample = source_sample * volume;
                }
                self.state
                    .source_frame
                    .store(frame.source_frame, Ordering::Release);
            } else {
                device_frame.fill(0.0);
                self.state.underruns.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn take_active_frame(&mut self, generation: u64) -> Option<QueuedFrame> {
        for _ in 0..self.stale_scan_limit {
            let frame = self.consumer.pop().ok()?;
            if frame.generation == generation
                && self.state.generation.load(Ordering::Acquire) == generation
            {
                return Some(frame);
            }
        }
        None
    }

    fn volume(&self) -> f32 {
        let volume = f32::from_bits(self.state.volume_bits.load(Ordering::Relaxed));
        if volume.is_finite() {
            volume.max(0.0)
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    };

    #[test]
    fn drops_stale_generations_and_reports_the_source_position() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(8);
        producer
            .push(QueuedFrame {
                generation: 1,
                source_frame: 10,
                left: 0.1,
                right: 0.2,
            })
            .unwrap();
        producer
            .push(QueuedFrame {
                generation: 2,
                source_frame: 20,
                left: 0.3,
                right: 0.4,
            })
            .unwrap();
        let state = Arc::new(RenderState::new());
        state.generation.store(2, Ordering::Release);
        state.playing.store(true, Ordering::Release);
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut output = [0.0_f32; 2];

        render.fill_f32(&mut output, 2);

        assert_eq!(output, [0.3, 0.4]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 20);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);
    }

    #[test]
    fn drains_exactly_the_captured_capacity_to_reach_an_active_frame_after_stale_frames() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(4);
        let capacity = producer.buffer().capacity();
        let state = Arc::new(RenderState::new());
        state.generation.store(2, Ordering::Release);
        state.playing.store(true, Ordering::Release);

        for source_frame in 0..capacity.saturating_sub(1) {
            producer
                .push(QueuedFrame {
                    generation: 1,
                    source_frame: source_frame as u64,
                    left: 0.1,
                    right: 0.2,
                })
                .unwrap();
        }
        producer
            .push(QueuedFrame {
                generation: 2,
                source_frame: 44,
                left: 0.6,
                right: 0.3,
            })
            .unwrap();
        assert!(producer
            .push(QueuedFrame {
                generation: 2,
                source_frame: 45,
                left: 0.0,
                right: 0.0,
            })
            .is_err());

        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        assert_eq!(render.stale_scan_limit, capacity);
        let mut output = [0.0_f32; 2];

        render.fill_f32(&mut output, 2);

        assert_eq!(output, [0.6, 0.3]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 44);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);
        assert_eq!(producer.slots(), capacity);
    }

    #[test]
    fn a_full_stale_ring_is_drained_with_one_underrun_and_without_extra_work() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(4);
        let capacity = producer.buffer().capacity();
        for source_frame in 0..capacity {
            producer
                .push(QueuedFrame {
                    generation: 3,
                    source_frame: source_frame as u64,
                    left: 0.5,
                    right: 0.5,
                })
                .unwrap();
        }
        assert!(producer
            .push(QueuedFrame {
                generation: 3,
                source_frame: 99,
                left: 0.5,
                right: 0.5,
            })
            .is_err());
        let state = Arc::new(RenderState::new());
        state.generation.store(4, Ordering::Release);
        state.playing.store(true, Ordering::Release);
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut output = [1.0_f32; 2];

        render.fill_f32(&mut output, 2);

        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(state.underruns.load(Ordering::Acquire), 1);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 0);
        assert_eq!(producer.slots(), capacity);
    }

    #[test]
    fn pause_outputs_silence_without_consuming_queued_audio() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(4);
        producer
            .push(QueuedFrame {
                generation: 0,
                source_frame: 8,
                left: 0.5,
                right: 0.25,
            })
            .unwrap();
        let state = Arc::new(RenderState::new());
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut output = [1.0_f32; 2];

        render.fill_f32(&mut output, 2);
        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);

        state.playing.store(true, Ordering::Release);
        render.fill_f32(&mut output, 2);
        assert_eq!(output, [0.5, 0.25]);
    }

    #[test]
    fn applies_atomic_volume_and_maps_channels_predictably() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(4);
        producer
            .push(QueuedFrame {
                generation: 0,
                source_frame: 4,
                left: 0.8,
                right: 0.4,
            })
            .unwrap();
        let state = Arc::new(RenderState::new());
        state.playing.store(true, Ordering::Release);
        state
            .volume_bits
            .store(0.5_f32.to_bits(), Ordering::Release);
        let mut render = RenderCore::new(consumer, state);
        let mut output = [0.0_f32; 3];

        render.fill_f32(&mut output, 3);

        assert_eq!(output, [0.4, 0.2, 0.2]);
    }

    #[test]
    fn mono_device_uses_the_left_channel_and_updates_the_source_frame() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(2);
        producer
            .push(QueuedFrame {
                generation: 0,
                source_frame: 13,
                left: 0.8,
                right: 0.2,
            })
            .unwrap();
        let state = Arc::new(RenderState::new());
        state.playing.store(true, Ordering::Release);
        state.set_volume(0.5);
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut output = [1.0_f32; 1];

        render.fill_f32(&mut output, 1);

        assert_eq!(output, [0.4]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 13);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);
    }

    #[test]
    fn zero_channel_count_never_panics_or_consumes_audio() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(2);
        producer
            .push(QueuedFrame {
                generation: 0,
                source_frame: 12,
                left: 0.5,
                right: 0.25,
            })
            .unwrap();
        let state = Arc::new(RenderState::new());
        state.playing.store(true, Ordering::Release);
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut output = [1.0_f32; 2];

        render.fill_f32(&mut output, 0);
        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);

        render.fill_f32(&mut output, 2);
        assert_eq!(output, [0.5, 0.25]);
    }

    #[test]
    fn render_state_uses_only_atomic_fields() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RenderState>();

        let _ = (AtomicBool::new(false), AtomicU32::new(0), AtomicU64::new(0));
    }
}
