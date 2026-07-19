use crate::{
    audio::{
        decoder::AudioDecoder,
        loop_cursor::LoopRange,
        render::{RenderCore, RenderState},
        worker::{run_worker, DecoderFrameSource, EngineCommand, WorkerRequest},
    },
    error::AppError,
    model::{AudioIdentity, PlaybackSnapshot, PlaybackState, Selection},
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use std::{
    path::Path,
    sync::{atomic::Ordering, Arc},
    thread::JoinHandle,
    time::Duration,
};

const COMMAND_CAPACITY: usize = 32;
const WORKER_FILL_BATCH_FRAMES: usize = 256;

pub fn ring_capacity_frames(sample_rate: u32) -> usize {
    sample_rate as usize
}

pub fn validate_volume(volume: f32) -> Result<f32, AppError> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        return Err(AppError::Audio(
            "Volume must be a finite value between 0 and 1".to_owned(),
        ));
    }
    Ok(volume)
}

pub fn seek_frame(
    milliseconds: u64,
    sample_rate: u32,
    duration_frames: u64,
) -> Result<u64, AppError> {
    if sample_rate == 0 || duration_frames == 0 {
        return Err(AppError::Audio(
            "Cannot seek audio without a valid duration and sample rate".to_owned(),
        ));
    }
    let requested = u128::from(milliseconds).saturating_mul(u128::from(sample_rate)) / 1_000;
    Ok(u64::try_from(requested)
        .unwrap_or(u64::MAX)
        .min(duration_frames))
}

pub fn selection_to_loop_range(
    selection: &Selection,
    sample_rate: u32,
    duration_frames: u64,
) -> Result<LoopRange, AppError> {
    let range = LoopRange::from_milliseconds(selection.start_ms, selection.end_ms, sample_rate)?;
    if range.end > duration_frames {
        return Err(AppError::Audio(
            "Loop selection must stay inside the open audio clip".to_owned(),
        ));
    }
    Ok(range)
}

pub fn frame_to_milliseconds(frame: u64, sample_rate: u32) -> Result<u64, AppError> {
    if sample_rate == 0 {
        return Err(AppError::Audio(
            "Cannot convert playback position with a zero sample rate".to_owned(),
        ));
    }
    let milliseconds = (u128::from(frame).saturating_mul(1_000) + u128::from(sample_rate) / 2)
        / u128::from(sample_rate);
    u64::try_from(milliseconds)
        .map_err(|_| AppError::Audio("Playback position exceeds millisecond range".to_owned()))
}

pub fn sample_to_i16(sample: f32) -> i16 {
    let sample = finite_clamped_sample(sample);
    if sample >= 0.0 {
        (sample * f32::from(i16::MAX)).round() as i16
    } else {
        (sample * 32_768.0).round() as i16
    }
}

pub fn sample_to_u16(sample: f32) -> u16 {
    let sample = finite_clamped_sample(sample);
    if sample >= 0.0 {
        (32_768.0 + sample * 32_767.0).round() as u16
    } else {
        (32_768.0 + sample * 32_768.0).round() as u16
    }
}

fn finite_clamped_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

struct ActivePlayback {
    command_tx: Option<Sender<EngineCommand>>,
    status_rx: Option<Receiver<Result<(), AppError>>>,
    render_state: Arc<RenderState>,
    stream: Option<cpal::Stream>,
    worker: Option<JoinHandle<()>>,
    identity: AudioIdentity,
    duration_frames: u64,
    loop_range: Option<Selection>,
}

impl ActivePlayback {
    fn send_command(&self, command: EngineCommand) -> Result<(), AppError> {
        let sender = self
            .command_tx
            .as_ref()
            .ok_or_else(|| AppError::Audio("Playback worker is not available".to_owned()))?;
        sender.try_send(command).map_err(|error| match error {
            TrySendError::Full(_) => {
                AppError::Audio("Playback command queue is temporarily full".to_owned())
            }
            TrySendError::Disconnected(_) => {
                AppError::Audio("Playback worker stopped unexpectedly".to_owned())
            }
        })
    }

    fn shutdown(&mut self) -> Result<(), AppError> {
        self.render_state.playing.store(false, Ordering::Release);
        self.stream.take();

        let mut shutdown_error = None;
        if let Some(sender) = self.command_tx.take() {
            if sender
                .send_timeout(EngineCommand::Shutdown, Duration::from_secs(1))
                .is_err()
            {
                shutdown_error = Some(AppError::Audio(
                    "Playback worker did not accept shutdown promptly".to_owned(),
                ));
            }
            drop(sender);
        }
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                shutdown_error = Some(AppError::Audio("Playback worker panicked".to_owned()));
            }
        }
        if let Some(status_rx) = self.status_rx.take() {
            match status_rx.try_recv() {
                Ok(Err(error)) => shutdown_error = Some(error),
                Ok(Ok(())) | Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
            }
        }
        shutdown_error.map_or(Ok(()), Err)
    }
}

pub struct AudioEngine {
    active: Option<ActivePlayback>,
    volume: f32,
    last_error: Option<String>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self {
            active: None,
            volume: 1.0,
            last_error: None,
        }
    }

    pub fn open(&mut self, path: &Path) -> Result<AudioIdentity, AppError> {
        let decoder = AudioDecoder::open(path)?;
        let identity = decoder.identity().clone();
        let duration_frames = decoder.total_frames();
        let source = DecoderFrameSource::new(decoder);
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or_else(|| {
            AppError::Audio("No default audio output device is available".to_owned())
        })?;
        let supported = select_output_config(&device, identity.sample_rate)?;
        let sample_format = supported.sample_format();
        let stream_config = supported.config();
        let output_channels = usize::from(stream_config.channels);
        if output_channels == 0 {
            return Err(AppError::Audio(
                "The selected output configuration has no channels".to_owned(),
            ));
        }

        let capacity = ring_capacity_frames(identity.sample_rate);
        if capacity == 0 {
            return Err(AppError::Audio(
                "Audio sample rate must be greater than zero".to_owned(),
            ));
        }
        let (producer, consumer) = rtrb::RingBuffer::new(capacity);
        let render_state = Arc::new(RenderState::new());
        render_state.set_volume(self.volume);
        let render = RenderCore::new(consumer, Arc::clone(&render_state));
        let stream = build_output_stream(
            &device,
            &stream_config,
            sample_format,
            render,
            Arc::clone(&render_state),
            identity.sample_rate,
        )?;

        let (command_tx, command_rx) = bounded(COMMAND_CAPACITY);
        let (status_tx, status_rx) = bounded(1);
        let worker_state = Arc::clone(&render_state);
        let lookahead_frames = (capacity / 4).max(1);
        let worker = std::thread::Builder::new()
            .name("lightscribe-audio-decoder".to_owned())
            .spawn(move || {
                run_worker(WorkerRequest {
                    source,
                    producer,
                    state: worker_state,
                    command_rx,
                    status_tx,
                    duration_frames,
                    initial_position: 0,
                    initial_loop: None,
                    fill_batch_frames: WORKER_FILL_BATCH_FRAMES,
                    lookahead_frames,
                });
            })
            .map_err(|error| {
                AppError::Audio(format!("Cannot start audio decoder worker: {error}"))
            })?;

        let mut replacement = ActivePlayback {
            command_tx: Some(command_tx),
            status_rx: Some(status_rx),
            render_state,
            stream: Some(stream),
            worker: Some(worker),
            identity: identity.clone(),
            duration_frames,
            loop_range: None,
        };
        if let Err(error) = replacement
            .stream
            .as_ref()
            .expect("replacement stream was just constructed")
            .play()
        {
            let _ = replacement.shutdown();
            return Err(AppError::Audio(format!(
                "Cannot start the default audio output stream: {error}"
            )));
        }

        let mut previous = self.active.replace(replacement);
        self.last_error = None;
        if let Some(active) = previous.as_mut() {
            let _ = active.shutdown();
        }
        Ok(identity)
    }

    pub fn play(&self) -> Result<(), AppError> {
        let active = self.active()?;
        active.send_command(EngineCommand::Play)?;
        active.render_state.playing.store(true, Ordering::Release);
        Ok(())
    }

    pub fn pause(&self) -> Result<(), AppError> {
        let active = self.active()?;
        active.send_command(EngineCommand::Pause)?;
        active.render_state.playing.store(false, Ordering::Release);
        Ok(())
    }

    pub fn seek_ms(&self, milliseconds: u64) -> Result<(), AppError> {
        let active = self.active()?;
        let frame = seek_frame(
            milliseconds,
            active.identity.sample_rate,
            active.duration_frames,
        )?;
        active.send_command(EngineCommand::Seek(frame))?;
        active
            .render_state
            .source_frame
            .store(frame, Ordering::Release);
        Ok(())
    }

    pub fn set_loop_ms(&mut self, selection: Option<Selection>) -> Result<(), AppError> {
        let active = self.active_mut()?;
        let range = selection
            .as_ref()
            .map(|value| {
                selection_to_loop_range(value, active.identity.sample_rate, active.duration_frames)
            })
            .transpose()?;
        active.send_command(EngineCommand::SetLoop(range))?;
        active.loop_range = selection;
        Ok(())
    }

    pub fn set_volume(&mut self, volume: f32) -> Result<(), AppError> {
        let volume = validate_volume(volume)?;
        self.volume = volume;
        if let Some(active) = self.active.as_ref() {
            active.render_state.set_volume(volume);
        }
        Ok(())
    }

    pub fn snapshot(&mut self) -> PlaybackSnapshot {
        self.refresh_worker_status();
        let Some(active) = self.active.as_ref() else {
            return PlaybackSnapshot {
                state: PlaybackState::Empty,
                position_ms: 0,
                duration_ms: 0,
                loop_range: None,
                volume: self.volume,
                underruns: 0,
            };
        };

        if active.render_state.stream_error.load(Ordering::Acquire) {
            self.last_error = Some("Audio output stream failed".to_owned());
            active.render_state.playing.store(false, Ordering::Release);
        }
        let state = if let Some(error) = self.last_error.as_ref() {
            PlaybackState::Error(error.clone())
        } else if active.render_state.playing.load(Ordering::Acquire) {
            PlaybackState::Playing
        } else {
            PlaybackState::Paused
        };
        let frame = active.render_state.source_frame.load(Ordering::Acquire);
        let position_ms = frame_to_milliseconds(frame, active.identity.sample_rate)
            .unwrap_or(active.identity.duration_ms)
            .min(active.identity.duration_ms);
        PlaybackSnapshot {
            state,
            position_ms,
            duration_ms: active.identity.duration_ms,
            loop_range: active.loop_range.clone(),
            volume: self.volume,
            underruns: active.render_state.underruns.load(Ordering::Relaxed),
        }
    }

    pub fn close(&mut self) -> Result<(), AppError> {
        let result = self
            .active
            .take()
            .map(|mut active| active.shutdown())
            .unwrap_or(Ok(()));
        self.last_error = None;
        result
    }

    fn active(&self) -> Result<&ActivePlayback, AppError> {
        self.active
            .as_ref()
            .ok_or_else(|| AppError::Audio("No audio clip is open".to_owned()))
    }

    fn active_mut(&mut self) -> Result<&mut ActivePlayback, AppError> {
        self.active
            .as_mut()
            .ok_or_else(|| AppError::Audio("No audio clip is open".to_owned()))
    }

    fn refresh_worker_status(&mut self) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let Some(status_rx) = active.status_rx.as_ref() else {
            return;
        };
        match status_rx.try_recv() {
            Ok(Err(error)) => {
                self.last_error = Some(error.to_string());
                active.render_state.playing.store(false, Ordering::Release);
            }
            Ok(Ok(())) => {
                self.last_error = Some("Playback worker stopped unexpectedly".to_owned());
                active.render_state.playing.store(false, Ordering::Release);
            }
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
        }
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        if let Some(mut active) = self.active.take() {
            let _ = active.shutdown();
        }
    }
}

fn select_output_config(
    device: &cpal::Device,
    source_sample_rate: u32,
) -> Result<cpal::SupportedStreamConfig, AppError> {
    let configs = device.supported_output_configs().map_err(|error| {
        AppError::Audio(format!(
            "Cannot query default output configurations: {error}"
        ))
    })?;
    configs
        .filter(|range| {
            range.min_sample_rate() <= source_sample_rate
                && source_sample_rate <= range.max_sample_rate()
                && matches!(
                    range.sample_format(),
                    cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16
                )
        })
        .min_by_key(|range| {
            let format_rank = match range.sample_format() {
                cpal::SampleFormat::F32 => 0_u8,
                cpal::SampleFormat::I16 => 1,
                cpal::SampleFormat::U16 => 2,
                _ => 3,
            };
            (range.channels().abs_diff(2), format_rank)
        })
        .map(|range| range.with_sample_rate(source_sample_rate))
        .ok_or_else(|| {
            AppError::Audio(format!(
                "Default output device has no f32/i16/u16 configuration supporting the source rate {source_sample_rate} Hz"
            ))
        })
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    render: RenderCore,
    state: Arc<RenderState>,
    source_sample_rate: u32,
) -> Result<cpal::Stream, AppError> {
    let output_channels = usize::from(config.channels);
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_f32_stream(device, config, render, state),
        cpal::SampleFormat::I16 => {
            let scratch = integer_scratch(source_sample_rate, output_channels)?;
            build_i16_stream(device, config, render, state, scratch)
        }
        cpal::SampleFormat::U16 => {
            let scratch = integer_scratch(source_sample_rate, output_channels)?;
            build_u16_stream(device, config, render, state, scratch)
        }
        _ => Err(AppError::Audio(
            "Selected output sample format is unsupported".to_owned(),
        )),
    }?;
    Ok(stream)
}

fn integer_scratch(sample_rate: u32, output_channels: usize) -> Result<Vec<f32>, AppError> {
    let samples = ring_capacity_frames(sample_rate)
        .checked_mul(output_channels)
        .ok_or_else(|| AppError::Audio("Output scratch size overflow".to_owned()))?;
    if samples == 0 {
        return Err(AppError::Audio(
            "Output scratch buffer cannot be empty".to_owned(),
        ));
    }
    let mut scratch = Vec::new();
    scratch.try_reserve_exact(samples).map_err(|_| {
        AppError::Audio("Cannot allocate the fixed integer output scratch buffer".to_owned())
    })?;
    scratch.resize(samples, 0.0);
    Ok(scratch)
}

fn build_f32_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut render: RenderCore,
    state: Arc<RenderState>,
) -> Result<cpal::Stream, AppError> {
    let channels = usize::from(config.channels);
    let error_state = Arc::clone(&state);
    device
        .build_output_stream(
            config,
            move |output: &mut [f32], _| render.fill_f32(output, channels),
            move |_| error_state.stream_error.store(true, Ordering::Release),
            None,
        )
        .map_err(|error| AppError::Audio(format!("Cannot build f32 output stream: {error}")))
}

fn build_i16_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut render: RenderCore,
    state: Arc<RenderState>,
    mut scratch: Vec<f32>,
) -> Result<cpal::Stream, AppError> {
    let channels = usize::from(config.channels);
    let error_state = Arc::clone(&state);
    device
        .build_output_stream(
            config,
            move |output: &mut [i16], _| {
                for output_chunk in output.chunks_mut(scratch.len()) {
                    let scratch_chunk = &mut scratch[..output_chunk.len()];
                    render.fill_f32(scratch_chunk, channels);
                    for (destination, source) in output_chunk.iter_mut().zip(scratch_chunk.iter()) {
                        *destination = sample_to_i16(*source);
                    }
                }
            },
            move |_| error_state.stream_error.store(true, Ordering::Release),
            None,
        )
        .map_err(|error| AppError::Audio(format!("Cannot build i16 output stream: {error}")))
}

fn build_u16_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut render: RenderCore,
    state: Arc<RenderState>,
    mut scratch: Vec<f32>,
) -> Result<cpal::Stream, AppError> {
    let channels = usize::from(config.channels);
    let error_state = Arc::clone(&state);
    device
        .build_output_stream(
            config,
            move |output: &mut [u16], _| {
                for output_chunk in output.chunks_mut(scratch.len()) {
                    let scratch_chunk = &mut scratch[..output_chunk.len()];
                    render.fill_f32(scratch_chunk, channels);
                    for (destination, source) in output_chunk.iter_mut().zip(scratch_chunk.iter()) {
                        *destination = sample_to_u16(*source);
                    }
                }
            },
            move |_| error_state.stream_error.store(true, Ordering::Release),
            None,
        )
        .map_err(|error| AppError::Audio(format!("Cannot build u16 output stream: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PlaybackSnapshot, PlaybackState, Selection};

    #[test]
    fn ring_capacity_is_exactly_one_second_of_source_frames() {
        assert_eq!(ring_capacity_frames(44_100), 44_100);
        assert_eq!(ring_capacity_frames(48_000), 48_000);
        assert_eq!(ring_capacity_frames(192_000), 192_000);
    }

    #[test]
    fn volume_validation_accepts_only_finite_unit_interval_values() {
        assert_eq!(validate_volume(0.0).unwrap(), 0.0);
        assert_eq!(validate_volume(1.0).unwrap(), 1.0);
        assert!(validate_volume(-0.001).is_err());
        assert!(validate_volume(1.001).is_err());
        assert!(validate_volume(f32::NAN).is_err());
        assert!(validate_volume(f32::INFINITY).is_err());
    }

    #[test]
    fn seek_milliseconds_clamp_to_the_authoritative_clip_extent() {
        assert_eq!(seek_frame(250, 48_000, 48_000).unwrap(), 12_000);
        assert_eq!(seek_frame(1_000, 48_000, 48_000).unwrap(), 48_000);
        assert_eq!(seek_frame(u64::MAX, 48_000, 48_000).unwrap(), 48_000);
        assert!(seek_frame(1, 0, 48_000).is_err());
        assert!(seek_frame(1, 48_000, 0).is_err());
    }

    #[test]
    fn loop_selection_must_be_inside_the_clip_and_uses_source_rate_conversion() {
        assert_eq!(
            selection_to_loop_range(
                &Selection {
                    start_ms: 250,
                    end_ms: 750,
                },
                48_000,
                48_000,
            )
            .unwrap(),
            LoopRange::new(12_000, 36_000).unwrap()
        );
        assert!(selection_to_loop_range(
            &Selection {
                start_ms: 750,
                end_ms: 1_001,
            },
            48_000,
            48_000,
        )
        .is_err());
        assert!(selection_to_loop_range(
            &Selection {
                start_ms: 500,
                end_ms: 500,
            },
            48_000,
            48_000,
        )
        .is_err());
    }

    #[test]
    fn source_frames_convert_to_integer_milliseconds_without_float_drift() {
        assert_eq!(frame_to_milliseconds(59_232, 48_000).unwrap(), 1_234);
        assert_eq!(frame_to_milliseconds(54_419, 44_100).unwrap(), 1_234);
        assert!(frame_to_milliseconds(1, 0).is_err());
    }

    #[test]
    fn integer_sample_conversion_is_clamped_and_deterministic() {
        assert_eq!(sample_to_i16(-1.0), i16::MIN);
        assert_eq!(sample_to_i16(0.0), 0);
        assert_eq!(sample_to_i16(1.0), i16::MAX);
        assert_eq!(sample_to_i16(2.0), i16::MAX);
        assert_eq!(sample_to_u16(-1.0), u16::MIN);
        assert_eq!(sample_to_u16(0.0), 32_768);
        assert_eq!(sample_to_u16(1.0), u16::MAX);
        assert_eq!(sample_to_u16(-2.0), u16::MIN);
    }

    #[test]
    fn playback_snapshot_and_error_wire_shapes_match_typescript() {
        let snapshot = PlaybackSnapshot {
            state: PlaybackState::Error("device lost".to_owned()),
            position_ms: 12,
            duration_ms: 34,
            loop_range: Some(Selection {
                start_ms: 10,
                end_ms: 20,
            }),
            volume: 0.5,
            underruns: 2,
        };

        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({
                "state": { "error": "device lost" },
                "positionMs": 12,
                "durationMs": 34,
                "loopRange": { "startMs": 10, "endMs": 20 },
                "volume": 0.5,
                "underruns": 2,
            })
        );
        assert_eq!(
            serde_json::to_value(crate::error::AppError::Audio("bad".to_owned())).unwrap(),
            serde_json::json!({ "kind": "audio", "message": "bad" })
        );
    }
}
