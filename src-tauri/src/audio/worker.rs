use crate::{
    audio::{
        decoder::{AudioDecoder, DecodedChunk},
        loop_cursor::{LoopCursor, LoopRange},
        render::{QueuedFrame, RenderState},
    },
    error::AppError,
};
use crossbeam_channel::{Receiver, Sender, TryRecvError};
use rtrb::Producer;
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(2);

#[derive(Debug, Clone, Copy)]
pub enum EngineCommand {
    Play,
    Pause,
    Seek(u64),
    SetLoop(Option<LoopRange>),
    Shutdown,
}

/// Source-frame decoder interface owned exclusively by the non-real-time worker.
pub trait FrameSource: Send + 'static {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
    fn seek_exact(&mut self, frame: u64) -> Result<(), AppError>;
    fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError>;
}

/// Streams bounded decoder chunks while preserving their real source-frame addresses.
pub struct DecoderFrameSource {
    decoder: AudioDecoder,
    chunk: Option<DecodedChunk>,
    chunk_offset: usize,
}

impl DecoderFrameSource {
    pub fn new(decoder: AudioDecoder) -> Self {
        Self {
            decoder,
            chunk: None,
            chunk_offset: 0,
        }
    }
}

impl FrameSource for DecoderFrameSource {
    fn sample_rate(&self) -> u32 {
        self.decoder.identity().sample_rate
    }

    fn channels(&self) -> u16 {
        self.decoder.identity().channels
    }

    fn seek_exact(&mut self, frame: u64) -> Result<(), AppError> {
        self.decoder.seek_exact(frame)?;
        self.chunk = None;
        self.chunk_offset = 0;
        Ok(())
    }

    fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError> {
        loop {
            if self.chunk.is_none() {
                self.chunk = self.decoder.decode_next()?;
                self.chunk_offset = 0;
            }
            let Some(chunk) = self.chunk.as_ref() else {
                return Ok(None);
            };
            let channels = usize::from(chunk.channels);
            if channels == 0 || chunk.interleaved.len() % channels != 0 {
                return Err(AppError::Audio(
                    "Decoder returned an invalid interleaved chunk".to_owned(),
                ));
            }
            if chunk.channels != self.channels() {
                return Err(AppError::Audio(
                    "Audio channel count changed while decoding".to_owned(),
                ));
            }
            let frame_count = chunk.interleaved.len() / channels;
            if self.chunk_offset >= frame_count {
                self.chunk = None;
                continue;
            }

            let start = self.chunk_offset * channels;
            let source_frame = chunk.start_frame + self.chunk_offset as u64;
            let (left, right) = downmix_stereo(&chunk.interleaved[start..start + channels])?;
            self.chunk_offset += 1;
            return Ok(Some((source_frame, left, right)));
        }
    }
}

/// Mono is duplicated. For multichannel audio, even-indexed channels are averaged into left and
/// odd-indexed channels into right. If one side has no channels, the populated side is duplicated.
pub fn downmix_stereo(samples: &[f32]) -> Result<(f32, f32), AppError> {
    if samples.is_empty() {
        return Err(AppError::Audio(
            "Cannot downmix a source frame with no channels".to_owned(),
        ));
    }
    if samples.len() == 1 {
        return Ok((samples[0], samples[0]));
    }

    let mut left = 0.0_f32;
    let mut right = 0.0_f32;
    let mut left_count = 0_u16;
    let mut right_count = 0_u16;
    for (channel, sample) in samples.iter().copied().enumerate() {
        if channel % 2 == 0 {
            left += sample;
            left_count += 1;
        } else {
            right += sample;
            right_count += 1;
        }
    }
    let left = left / f32::from(left_count);
    let right = if right_count == 0 {
        left
    } else {
        right / f32::from(right_count)
    };
    Ok((left, right))
}

pub fn fill_generation<S: FrameSource>(
    mut source: S,
    mut producer: Producer<QueuedFrame>,
    state: Arc<RenderState>,
    generation: u64,
    position: u64,
    range: Option<LoopRange>,
    count: usize,
) -> Result<(), AppError> {
    let mut cursor = LoopCursor::new(position, range);
    let mut expected_next = None;
    for _ in 0..count {
        let wanted = cursor.take();
        if expected_next != Some(wanted) {
            source.seek_exact(wanted)?;
        }
        let (actual, left, right) = source
            .next_stereo()?
            .ok_or_else(|| AppError::Audio("Unexpected end of audio".to_owned()))?;
        if actual != wanted {
            return Err(AppError::Audio(format!(
                "Decoder returned frame {actual}, expected {wanted}"
            )));
        }
        let mut queued = QueuedFrame {
            generation,
            source_frame: actual,
            left,
            right,
        };
        loop {
            match producer.push(queued) {
                Ok(()) => break,
                Err(rtrb::PushError::Full(value)) => {
                    queued = value;
                    std::thread::yield_now();
                }
            }
        }
        expected_next = wanted.checked_add(1);
    }
    state.source_frame.store(position, Ordering::Release);
    Ok(())
}

pub(crate) struct WorkerRequest<S: FrameSource> {
    pub source: S,
    pub producer: Producer<QueuedFrame>,
    pub state: Arc<RenderState>,
    pub command_rx: Receiver<EngineCommand>,
    pub status_tx: Sender<Result<(), AppError>>,
    pub duration_frames: u64,
    pub initial_position: u64,
    pub initial_loop: Option<LoopRange>,
    pub fill_batch_frames: usize,
    pub lookahead_frames: usize,
}

pub(crate) fn run_worker<S: FrameSource>(request: WorkerRequest<S>) {
    let WorkerRequest {
        mut source,
        mut producer,
        state,
        command_rx,
        status_tx,
        duration_frames,
        initial_position,
        initial_loop,
        fill_batch_frames,
        lookahead_frames,
    } = request;
    let _source_contract = (source.sample_rate(), source.channels());
    let capacity = producer.buffer().capacity();
    let lookahead_frames = lookahead_frames.clamp(1, capacity);
    let fill_batch_frames = fill_batch_frames.max(1);
    let mut cursor = LoopCursor::new(initial_position, initial_loop);
    let mut expected_next = None;
    let mut at_end = false;

    loop {
        match drain_commands(
            &command_rx,
            &state,
            &mut cursor,
            &mut expected_next,
            &mut at_end,
        ) {
            CommandAction::Continue => {}
            CommandAction::Stop => {
                let _ = status_tx.try_send(Ok(()));
                return;
            }
        }

        let queued = capacity.saturating_sub(producer.slots());
        if at_end || queued >= lookahead_frames {
            match command_rx.recv_timeout(COMMAND_POLL_INTERVAL) {
                Ok(command) => {
                    if apply_command(
                        command,
                        &state,
                        &mut cursor,
                        &mut expected_next,
                        &mut at_end,
                    ) == CommandAction::Stop
                    {
                        let _ = status_tx.try_send(Ok(()));
                        return;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    let _ = status_tx.try_send(Ok(()));
                    return;
                }
            }
            continue;
        }

        let wanted_fill = lookahead_frames - queued;
        for _ in 0..wanted_fill.min(fill_batch_frames) {
            match command_rx.try_recv() {
                Ok(command) => {
                    if apply_command(
                        command,
                        &state,
                        &mut cursor,
                        &mut expected_next,
                        &mut at_end,
                    ) == CommandAction::Stop
                    {
                        let _ = status_tx.try_send(Ok(()));
                        return;
                    }
                    break;
                }
                Err(TryRecvError::Disconnected) => {
                    let _ = status_tx.try_send(Ok(()));
                    return;
                }
                Err(TryRecvError::Empty) => {}
            }

            let wanted = cursor.take();
            if cursor.range().is_none() && wanted >= duration_frames {
                at_end = true;
                state.playing.store(false, Ordering::Release);
                break;
            }
            let result = queue_one_frame(
                &mut source,
                &mut producer,
                &state,
                &mut expected_next,
                wanted,
            );
            if let Err(error) = result {
                state.playing.store(false, Ordering::Release);
                let _ = status_tx.try_send(Err(error));
                return;
            }
        }
    }
}

fn queue_one_frame<S: FrameSource>(
    source: &mut S,
    producer: &mut Producer<QueuedFrame>,
    state: &RenderState,
    expected_next: &mut Option<u64>,
    wanted: u64,
) -> Result<(), AppError> {
    if *expected_next != Some(wanted) {
        source.seek_exact(wanted)?;
    }
    let (actual, left, right) = source.next_stereo()?.ok_or_else(|| {
        AppError::Audio("Audio ended before its declared frame extent".to_owned())
    })?;
    if actual != wanted {
        return Err(AppError::Audio(format!(
            "Decoder returned frame {actual}, expected {wanted}"
        )));
    }
    let frame = QueuedFrame {
        generation: state.generation.load(Ordering::Acquire),
        source_frame: actual,
        left,
        right,
    };
    producer.push(frame).map_err(|_| {
        AppError::Audio("Playback ring became full during a bounded fill batch".to_owned())
    })?;
    *expected_next = wanted.checked_add(1);
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandAction {
    Continue,
    Stop,
}

fn drain_commands(
    command_rx: &Receiver<EngineCommand>,
    state: &RenderState,
    cursor: &mut LoopCursor,
    expected_next: &mut Option<u64>,
    at_end: &mut bool,
) -> CommandAction {
    loop {
        match command_rx.try_recv() {
            Ok(command) => {
                if apply_command(command, state, cursor, expected_next, at_end)
                    == CommandAction::Stop
                {
                    return CommandAction::Stop;
                }
            }
            Err(TryRecvError::Empty) => return CommandAction::Continue,
            Err(TryRecvError::Disconnected) => return CommandAction::Stop,
        }
    }
}

fn apply_command(
    command: EngineCommand,
    state: &RenderState,
    cursor: &mut LoopCursor,
    expected_next: &mut Option<u64>,
    at_end: &mut bool,
) -> CommandAction {
    match command {
        EngineCommand::Play => state.playing.store(true, Ordering::Release),
        EngineCommand::Pause => state.playing.store(false, Ordering::Release),
        EngineCommand::Seek(frame) => {
            state.generation.fetch_add(1, Ordering::AcqRel);
            state.source_frame.store(frame, Ordering::Release);
            cursor.set_position(frame);
            *expected_next = None;
            *at_end = false;
        }
        EngineCommand::SetLoop(range) => {
            state.generation.fetch_add(1, Ordering::AcqRel);
            cursor.set_position(state.source_frame.load(Ordering::Acquire));
            cursor.set_range(range);
            *expected_next = None;
            *at_end = false;
        }
        EngineCommand::Shutdown => return CommandAction::Stop,
    }
    CommandAction::Continue
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{
        loop_cursor::LoopRange,
        render::{QueuedFrame, RenderState},
    };
    use crossbeam_channel::bounded;
    use std::{
        sync::{atomic::Ordering, Arc, Mutex},
        time::Duration,
    };

    struct SyntheticSource {
        sample_rate: u32,
        channels: u16,
        frames: Vec<(u64, Vec<f32>)>,
        next: usize,
        seeks: Arc<Mutex<Vec<u64>>>,
    }

    impl SyntheticSource {
        fn stereo_ramp(sample_rate: u32, start: u64, count: u64) -> Self {
            Self {
                sample_rate,
                channels: 2,
                frames: (start..start + count)
                    .map(|frame| (frame, vec![frame as f32, -(frame as f32)]))
                    .collect(),
                next: 0,
                seeks: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl FrameSource for SyntheticSource {
        fn sample_rate(&self) -> u32 {
            self.sample_rate
        }

        fn channels(&self) -> u16 {
            self.channels
        }

        fn seek_exact(&mut self, frame: u64) -> Result<(), AppError> {
            self.seeks.lock().unwrap().push(frame);
            self.next = self
                .frames
                .iter()
                .position(|(source_frame, _)| *source_frame == frame)
                .ok_or_else(|| {
                    AppError::Audio(format!("Synthetic frame {frame} is unavailable"))
                })?;
            Ok(())
        }

        fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError> {
            let Some((source_frame, samples)) = self.frames.get(self.next) else {
                return Ok(None);
            };
            self.next += 1;
            let (left, right) = downmix_stereo(samples)?;
            Ok(Some((*source_frame, left, right)))
        }
    }

    #[test]
    fn fill_generation_queues_the_exact_end_exclusive_loop_sequence() {
        let source = SyntheticSource::stereo_ramp(48_000, 0, 200);
        let seeks = Arc::clone(&source.seeks);
        let (producer, mut consumer) = rtrb::RingBuffer::new(128);
        let state = Arc::new(RenderState::new());
        state.generation.store(7, Ordering::Release);

        fill_generation(
            source,
            producer,
            Arc::clone(&state),
            7,
            94,
            Some(LoopRange::new(48, 96).unwrap()),
            5,
        )
        .unwrap();

        let frames = (0..5).map(|_| consumer.pop().unwrap()).collect::<Vec<_>>();
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.source_frame)
                .collect::<Vec<_>>(),
            vec![94, 95, 48, 49, 50]
        );
        assert!(frames.iter().all(|frame| frame.generation == 7));
        assert_eq!(*seeks.lock().unwrap(), vec![94, 48]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 94);
    }

    #[test]
    fn fill_generation_preserves_real_nonzero_source_frame_numbers() {
        let source = SyntheticSource::stereo_ramp(1_000, 40, 8);
        let (producer, mut consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());

        fill_generation(source, producer, state, 3, 42, None, 3).unwrap();

        let frames = (0..3).map(|_| consumer.pop().unwrap()).collect::<Vec<_>>();
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.source_frame)
                .collect::<Vec<_>>(),
            vec![42, 43, 44]
        );
        assert_eq!(frames[0].left, 42.0);
        assert_eq!(frames[0].right, -42.0);
    }

    #[test]
    fn deterministic_downmix_duplicates_mono_and_averages_even_and_odd_channels() {
        assert_eq!(downmix_stereo(&[0.25]).unwrap(), (0.25, 0.25));
        assert_eq!(downmix_stereo(&[1.0, 2.0]).unwrap(), (1.0, 2.0));
        assert_eq!(downmix_stereo(&[1.0, 2.0, 3.0]).unwrap(), (2.0, 2.0));
        assert_eq!(downmix_stereo(&[1.0, 2.0, 5.0, 8.0]).unwrap(), (3.0, 5.0));
        assert!(downmix_stereo(&[]).is_err());
    }

    #[test]
    fn seek_advances_generation_before_new_frames_are_queued() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 100);
        let (producer, mut consumer) = rtrb::RingBuffer::new(16);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(8);
        let (status_tx, status_rx) = bounded(1);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 100,
                initial_position: 0,
                initial_loop: None,
                fill_batch_frames: 4,
                lookahead_frames: 8,
            });
        });

        while consumer.pop().is_err() {
            std::thread::yield_now();
        }
        command_tx.send(EngineCommand::Seek(50)).unwrap();
        let generation = wait_for_generation(&state, 1);

        let current = loop {
            if let Ok(frame) = consumer.pop() {
                if frame.generation == generation {
                    break frame;
                }
            } else {
                std::thread::yield_now();
            }
        };
        assert_eq!(current.source_frame, 50);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 50);

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(status_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn end_of_stream_pauses_without_reporting_a_decoder_error() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 3);
        let (producer, mut consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());
        state.playing.store(true, Ordering::Release);
        let (command_tx, command_rx) = bounded(2);
        let (status_tx, status_rx) = bounded(1);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 3,
                initial_position: 0,
                initial_loop: None,
                fill_batch_frames: 8,
                lookahead_frames: 8,
            });
        });

        let mut queued = Vec::new();
        while queued.len() < 3 {
            if let Ok(frame) = consumer.pop() {
                queued.push(frame.source_frame);
            } else {
                std::thread::yield_now();
            }
        }
        for _ in 0..10_000 {
            if !state.playing.load(Ordering::Acquire) {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(queued, vec![0, 1, 2]);
        assert!(!state.playing.load(Ordering::Acquire));
        assert!(status_rx.try_recv().is_err());

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(status_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn paused_worker_with_a_full_ring_still_processes_seek_loop_and_shutdown() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 100);
        let (producer, _consumer) = rtrb::RingBuffer::<QueuedFrame>::new(2);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(8);
        let (status_tx, status_rx) = bounded(1);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 100,
                initial_position: 0,
                initial_loop: None,
                fill_batch_frames: 2,
                lookahead_frames: 2,
            });
        });

        command_tx.send(EngineCommand::Seek(25)).unwrap();
        command_tx
            .send(EngineCommand::SetLoop(Some(
                LoopRange::new(20, 30).unwrap(),
            )))
            .unwrap();
        let generation = wait_for_generation(&state, 2);
        assert_eq!(generation, 2);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 25);

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(status_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        worker.join().unwrap();
    }

    fn wait_for_generation(state: &RenderState, wanted: u64) -> u64 {
        for _ in 0..100_000 {
            let generation = state.generation.load(Ordering::Acquire);
            if generation >= wanted {
                return generation;
            }
            std::thread::yield_now();
        }
        panic!("worker did not advance to generation {wanted}");
    }
}
