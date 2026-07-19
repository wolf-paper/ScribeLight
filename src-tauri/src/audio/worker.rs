use crate::{
    audio::{
        decoder::{AudioDecoder, DecodedChunk},
        loop_cursor::{LoopCursor, LoopRange},
        render::{QueuedFrame, RenderState, NO_TERMINAL_GENERATION},
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

#[derive(Debug)]
pub enum WorkerStatus {
    Ready,
    Error(AppError),
    Stopped,
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
            terminal: false,
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
    pub status_tx: Sender<WorkerStatus>,
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
    let mut ready_sent = false;
    let mut resume_after_refill = false;

    loop {
        match drain_commands(
            &command_rx,
            &state,
            &mut cursor,
            &mut expected_next,
            &mut at_end,
            &mut resume_after_refill,
            duration_frames,
        ) {
            CommandAction::Continue => {}
            CommandAction::Stop => {
                let _ = status_tx.try_send(WorkerStatus::Stopped);
                return;
            }
        }

        let queued = capacity.saturating_sub(producer.slots());
        let refill_complete = at_end || queued >= lookahead_frames;
        if !ready_sent && refill_complete {
            if status_tx.try_send(WorkerStatus::Ready).is_err() {
                return;
            }
            ready_sent = true;
        }
        if resume_after_refill && refill_complete {
            state.playing.store(true, Ordering::Release);
            resume_after_refill = false;
        }
        if at_end || queued >= lookahead_frames {
            match command_rx.recv_timeout(COMMAND_POLL_INTERVAL) {
                Ok(command) => {
                    if apply_command(
                        command,
                        &state,
                        &mut cursor,
                        &mut expected_next,
                        &mut at_end,
                        &mut resume_after_refill,
                        duration_frames,
                    ) == CommandAction::Stop
                    {
                        let _ = status_tx.try_send(WorkerStatus::Stopped);
                        return;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    let _ = status_tx.try_send(WorkerStatus::Stopped);
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
                        &mut resume_after_refill,
                        duration_frames,
                    ) == CommandAction::Stop
                    {
                        let _ = status_tx.try_send(WorkerStatus::Stopped);
                        return;
                    }
                    break;
                }
                Err(TryRecvError::Disconnected) => {
                    let _ = status_tx.try_send(WorkerStatus::Stopped);
                    return;
                }
                Err(TryRecvError::Empty) => {}
            }

            let wanted = cursor.take();
            if cursor.range().is_none() && wanted >= duration_frames {
                at_end = true;
                break;
            }
            let terminal = cursor.range().is_none()
                && wanted
                    .checked_add(1)
                    .is_none_or(|next| next >= duration_frames);
            let result = queue_one_frame(
                &mut source,
                &mut producer,
                &state,
                &mut expected_next,
                wanted,
                terminal,
            );
            if let Err(error) = result {
                state.playing.store(false, Ordering::Release);
                let _ = status_tx.try_send(WorkerStatus::Error(error));
                return;
            }
            if terminal {
                at_end = true;
                break;
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
    terminal: bool,
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
        terminal,
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
    resume_after_refill: &mut bool,
    duration_frames: u64,
) -> CommandAction {
    loop {
        match command_rx.try_recv() {
            Ok(command) => {
                if apply_command(
                    command,
                    state,
                    cursor,
                    expected_next,
                    at_end,
                    resume_after_refill,
                    duration_frames,
                ) == CommandAction::Stop
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
    resume_after_refill: &mut bool,
    duration_frames: u64,
) -> CommandAction {
    match command {
        EngineCommand::Play => {
            let generation = state.generation.load(Ordering::Acquire);
            if state.terminal_generation.load(Ordering::Acquire) == generation {
                let restart = cursor.range().map_or(0, |range| range.start);
                state.generation.fetch_add(1, Ordering::AcqRel);
                state
                    .terminal_generation
                    .store(NO_TERMINAL_GENERATION, Ordering::Release);
                state.source_frame.store(restart, Ordering::Release);
                state.playing.store(false, Ordering::Release);
                cursor.set_position(restart);
                *expected_next = None;
                *at_end = false;
                *resume_after_refill = true;
            } else {
                state.playing.store(true, Ordering::Release);
            }
        }
        EngineCommand::Pause => {
            state.playing.store(false, Ordering::Release);
            *resume_after_refill = false;
        }
        EngineCommand::Seek(frame) => {
            let generation = state
                .generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            state.source_frame.store(frame, Ordering::Release);
            cursor.set_position(frame);
            *expected_next = None;
            if frame >= duration_frames {
                state.playing.store(false, Ordering::Release);
                *at_end = true;
                *resume_after_refill = false;
                state
                    .terminal_generation
                    .store(generation, Ordering::Release);
            } else {
                state
                    .terminal_generation
                    .store(NO_TERMINAL_GENERATION, Ordering::Release);
                *at_end = false;
            }
        }
        EngineCommand::SetLoop(range) => {
            let generation = state
                .generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            let source_frame = state.source_frame.load(Ordering::Acquire);
            cursor.set_position(source_frame);
            cursor.set_range(range);
            *expected_next = None;
            if range.is_none() && source_frame >= duration_frames {
                state.playing.store(false, Ordering::Release);
                *at_end = true;
                *resume_after_refill = false;
                state
                    .terminal_generation
                    .store(generation, Ordering::Release);
            } else {
                state
                    .terminal_generation
                    .store(NO_TERMINAL_GENERATION, Ordering::Release);
                *at_end = false;
            }
        }
        EngineCommand::Shutdown => return CommandAction::Stop,
    }
    CommandAction::Continue
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{
        decoder::AudioDecoder,
        loop_cursor::LoopRange,
        render::{QueuedFrame, RenderCore, RenderState, NO_TERMINAL_GENERATION},
    };
    use crossbeam_channel::bounded;
    use std::{
        sync::{atomic::Ordering, Arc, Mutex},
        time::{Duration, Instant},
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

    struct FailingSource;

    impl FrameSource for FailingSource {
        fn sample_rate(&self) -> u32 {
            1_000
        }

        fn channels(&self) -> u16 {
            2
        }

        fn seek_exact(&mut self, _frame: u64) -> Result<(), AppError> {
            Err(AppError::Audio(
                "synthetic initial refill failed".to_owned(),
            ))
        }

        fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError> {
            unreachable!("initial seek must fail before decoding")
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
        let (status_tx, status_rx) = bounded(2);
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

        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));

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
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
        worker.join().unwrap();
    }

    #[test]
    fn short_clip_is_prefilled_then_renders_its_final_frame_before_pausing() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 3);
        let (producer, consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(2);
        let (status_tx, status_rx) = bounded(2);
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

        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));
        assert!(!state.playing.load(Ordering::Acquire));
        assert_eq!(
            state.terminal_generation.load(Ordering::Acquire),
            NO_TERMINAL_GENERATION
        );
        let mut render = RenderCore::new(consumer, Arc::clone(&state));
        let mut paused_output = [9.0_f32; 2];
        render.fill_f32(&mut paused_output, 2);
        assert_eq!(paused_output, [0.0, 0.0]);

        command_tx.send(EngineCommand::Play).unwrap();
        wait_for_playing(&state, true);
        let mut output = [9.0_f32; 10];
        render.fill_f32(&mut output, 2);

        assert_eq!(output, [0.0, 0.0, 1.0, -1.0, 2.0, -2.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 2);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);
        assert_eq!(state.terminal_generation.load(Ordering::Acquire), 0);
        assert!(!state.playing.load(Ordering::Acquire));

        command_tx.send(EngineCommand::Play).unwrap();
        let replay_generation = wait_for_generation(&state, 1);
        assert_eq!(replay_generation, 1);
        wait_for_playing(&state, true);
        let mut replay = [9.0_f32; 8];
        render.fill_f32(&mut replay, 2);

        assert_eq!(replay, [0.0, 0.0, 1.0, -1.0, 2.0, -2.0, 0.0, 0.0]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 2);
        assert_eq!(state.underruns.load(Ordering::Acquire), 0);
        assert_eq!(state.terminal_generation.load(Ordering::Acquire), 1);
        assert!(!state.playing.load(Ordering::Acquire));

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
        worker.join().unwrap();
    }

    #[test]
    fn paused_exact_end_seek_is_terminal_and_play_restarts_from_zero() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 5);
        let (producer, mut consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(4);
        let (status_tx, status_rx) = bounded(2);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 5,
                initial_position: 0,
                initial_loop: None,
                fill_batch_frames: 8,
                lookahead_frames: 8,
            });
        });
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));

        command_tx.send(EngineCommand::Seek(5)).unwrap();
        let terminal_generation = wait_for_terminal_generation(&state, 1);
        assert_eq!(terminal_generation, 1);
        assert_eq!(state.generation.load(Ordering::Acquire), 1);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 5);
        assert!(!state.playing.load(Ordering::Acquire));

        command_tx.send(EngineCommand::Play).unwrap();
        let replay_generation = wait_for_generation(&state, 2);
        wait_for_playing(&state, true);
        let restarted = wait_for_generation_frame(&mut consumer, replay_generation);
        assert_eq!(restarted.source_frame, 0);
        assert_eq!(
            state.terminal_generation.load(Ordering::Acquire),
            NO_TERMINAL_GENERATION
        );

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
        worker.join().unwrap();
    }

    #[test]
    fn playing_exact_end_seek_pauses_and_play_restarts_from_active_loop_start() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 100);
        let range = LoopRange::new(20, 30).unwrap();
        let (producer, mut consumer) = rtrb::RingBuffer::new(16);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(4);
        let (status_tx, status_rx) = bounded(2);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 100,
                initial_position: range.start,
                initial_loop: Some(range),
                fill_batch_frames: 8,
                lookahead_frames: 8,
            });
        });
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));
        command_tx.send(EngineCommand::Play).unwrap();
        wait_for_playing(&state, true);

        command_tx.send(EngineCommand::Seek(100)).unwrap();
        let terminal_generation = wait_for_terminal_generation(&state, 1);
        assert_eq!(terminal_generation, 1);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 100);
        assert!(!state.playing.load(Ordering::Acquire));

        command_tx.send(EngineCommand::Play).unwrap();
        let replay_generation = wait_for_generation(&state, 2);
        wait_for_playing(&state, true);
        let restarted = wait_for_generation_frame(&mut consumer, replay_generation);
        assert_eq!(restarted.source_frame, range.start);
        assert_eq!(
            state.terminal_generation.load(Ordering::Acquire),
            NO_TERMINAL_GENERATION
        );

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
        worker.join().unwrap();
    }

    #[test]
    fn clearing_loop_after_exact_end_seek_stays_terminal_and_play_restarts_from_zero() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 5);
        let (producer, mut consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(4);
        let (status_tx, status_rx) = bounded(2);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source,
                producer,
                state: worker_state,
                command_rx,
                status_tx,
                duration_frames: 5,
                initial_position: 0,
                initial_loop: Some(LoopRange::new(1, 4).unwrap()),
                fill_batch_frames: 8,
                lookahead_frames: 8,
            });
        });
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));

        command_tx.send(EngineCommand::Seek(5)).unwrap();
        wait_for_terminal_generation(&state, 1);
        command_tx.send(EngineCommand::SetLoop(None)).unwrap();
        let terminal_generation = wait_for_terminal_generation(&state, 2);

        assert_eq!(terminal_generation, 2);
        assert_eq!(state.generation.load(Ordering::Acquire), 2);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 5);
        assert!(!state.playing.load(Ordering::Acquire));

        command_tx.send(EngineCommand::Play).unwrap();
        let replay_generation = wait_for_generation(&state, 3);
        wait_for_playing(&state, true);
        let restarted = wait_for_generation_frame(&mut consumer, replay_generation);
        assert_eq!(restarted.source_frame, 0);
        assert_eq!(
            state.terminal_generation.load(Ordering::Acquire),
            NO_TERMINAL_GENERATION
        );

        command_tx.send(EngineCommand::Shutdown).unwrap();
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
        worker.join().unwrap();
    }

    #[test]
    fn clearing_loop_midstream_preserves_position_and_playing_state() {
        let state = RenderState::new();
        state.source_frame.store(25, Ordering::Release);
        state.playing.store(true, Ordering::Release);
        let mut cursor = LoopCursor::new(25, Some(LoopRange::new(20, 30).unwrap()));
        let mut expected_next = Some(26);
        let mut at_end = false;
        let mut resume_after_refill = false;

        assert!(
            apply_command(
                EngineCommand::SetLoop(None),
                &state,
                &mut cursor,
                &mut expected_next,
                &mut at_end,
                &mut resume_after_refill,
                100,
            ) == CommandAction::Continue
        );

        assert_eq!(state.generation.load(Ordering::Acquire), 1);
        assert_eq!(
            state.terminal_generation.load(Ordering::Acquire),
            NO_TERMINAL_GENERATION
        );
        assert_eq!(cursor.position(), 25);
        assert_eq!(cursor.range(), None);
        assert_eq!(expected_next, None);
        assert!(!at_end);
        assert!(state.playing.load(Ordering::Acquire));

        apply_command(
            EngineCommand::Play,
            &state,
            &mut cursor,
            &mut expected_next,
            &mut at_end,
            &mut resume_after_refill,
            100,
        );
        assert_eq!(state.generation.load(Ordering::Acquire), 1);
        assert!(state.playing.load(Ordering::Acquire));
        assert_eq!(cursor.position(), 25);
    }

    #[test]
    fn initial_refill_error_is_reported_before_ready() {
        let (producer, _consumer) = rtrb::RingBuffer::new(8);
        let state = Arc::new(RenderState::new());
        let (_command_tx, command_rx) = bounded(2);
        let (status_tx, status_rx) = bounded(2);
        let worker = std::thread::spawn(move || {
            run_worker(WorkerRequest {
                source: FailingSource,
                producer,
                state,
                command_rx,
                status_tx,
                duration_frames: 3,
                initial_position: 0,
                initial_loop: None,
                fill_batch_frames: 8,
                lookahead_frames: 8,
            });
        });

        match status_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
            WorkerStatus::Error(AppError::Audio(message)) => {
                assert_eq!(message, "synthetic initial refill failed")
            }
            other => panic!("expected initial worker error, got {other:?}"),
        }
        worker.join().unwrap();
    }

    #[test]
    fn decoder_frame_source_crosses_a_real_chunk_boundary_with_exact_frames_and_downmix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("four-channel.wav");
        let spec = hound::WavSpec {
            channels: 4,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..20_000 {
            for sample in [1_000_i16, 2_000, 3_000, 4_000] {
                writer.write_sample(sample).unwrap();
            }
        }
        writer.finalize().unwrap();

        let mut boundary_decoder = AudioDecoder::open(&path).unwrap();
        let first = boundary_decoder.decode_next().unwrap().unwrap();
        let first_frames = first.interleaved.len() / usize::from(first.channels);
        assert!(
            first_frames < 20_000,
            "fixture must span multiple decoded chunks"
        );

        let decoder = AudioDecoder::open(&path).unwrap();
        let mut source = DecoderFrameSource::new(decoder);
        source.seek_exact(0).unwrap();
        let mut previous = None;
        for expected_frame in 0..=first_frames as u64 + 1 {
            let (source_frame, left, right) = source.next_stereo().unwrap().unwrap();
            assert_eq!(source_frame, expected_frame);
            if let Some(previous) = previous {
                assert_eq!(source_frame, previous + 1);
            }
            assert!((left - 2_000.0 / 32_768.0).abs() < 1e-6);
            assert!((right - 3_000.0 / 32_768.0).abs() < 1e-6);
            previous = Some(source_frame);
        }
    }

    #[test]
    fn paused_worker_with_a_full_ring_still_processes_seek_loop_and_shutdown() {
        let source = SyntheticSource::stereo_ramp(1_000, 0, 100);
        let (producer, _consumer) = rtrb::RingBuffer::<QueuedFrame>::new(2);
        let state = Arc::new(RenderState::new());
        let (command_tx, command_rx) = bounded(8);
        let (status_tx, status_rx) = bounded(2);
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

        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Ready
        ));

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
        assert!(matches!(
            status_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            WorkerStatus::Stopped
        ));
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

    fn wait_for_playing(state: &RenderState, wanted: bool) {
        for _ in 0..100_000 {
            if state.playing.load(Ordering::Acquire) == wanted {
                return;
            }
            std::thread::yield_now();
        }
        panic!("worker did not set playing to {wanted}");
    }

    fn wait_for_terminal_generation(state: &RenderState, wanted: u64) -> u64 {
        for _ in 0..100_000 {
            let generation = state.terminal_generation.load(Ordering::Acquire);
            if generation == wanted {
                return generation;
            }
            std::thread::yield_now();
        }
        panic!("worker did not mark generation {wanted} terminal");
    }

    fn wait_for_generation_frame(
        consumer: &mut rtrb::Consumer<QueuedFrame>,
        generation: u64,
    ) -> QueuedFrame {
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if let Ok(frame) = consumer.pop() {
                if frame.generation == generation {
                    return frame;
                }
            } else {
                std::thread::yield_now();
            }
        }
        panic!("worker did not queue a frame for generation {generation}");
    }
}
