use crate::{error::AppError, model::AudioIdentity};
use std::{fs::File, path::Path};
use symphonia::core::{
    codecs::{
        audio::{AudioDecoder as SymphoniaDecoder, AudioDecoderOptions},
        CodecParameters,
    },
    errors::Error as SymphoniaError,
    formats::{probe::Hint, FormatOptions, FormatReader, SeekMode, SeekTo, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
    units::{Time, TimeBase, Timestamp},
};

const MAX_DURATION_MS: u64 = 30 * 60 * 1_000;

pub struct DecodedChunk {
    pub start_frame: u64,
    pub channels: u16,
    pub interleaved: Vec<f32>,
}

pub struct AudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn SymphoniaDecoder>,
    track_id: u32,
    time_base: TimeBase,
    identity: AudioIdentity,
    total_frames: u64,
    next_frame: u64,
    pending: Option<DecodedChunk>,
}

impl AudioDecoder {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension != "mp3" && extension != "wav" {
            return Err(AppError::Audio(
                "Only MP3 and WAV files are supported".to_owned(),
            ));
        }

        let canonical = path.canonicalize()?;
        let metadata = std::fs::metadata(&canonical)?;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_default();

        let mut hint = Hint::new();
        hint.with_extension(&extension);
        let stream = MediaSourceStream::new(Box::new(File::open(&canonical)?), Default::default());
        let format = symphonia::default::get_probe()
            .probe(
                &hint,
                stream,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(audio_error)?;
        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| AppError::Audio("No audio track found".to_owned()))?;
        let track_id = track.id;
        let params = track
            .codec_params
            .as_ref()
            .and_then(CodecParameters::audio)
            .cloned()
            .ok_or_else(|| AppError::Audio("Audio codec parameters are unavailable".to_owned()))?;
        let sample_rate = params
            .sample_rate
            .ok_or_else(|| AppError::Audio("Audio sample rate is unknown".to_owned()))?;
        let channels = params
            .channels
            .as_ref()
            .map(|value| value.count() as u16)
            .ok_or_else(|| AppError::Audio("Audio channel count is unknown".to_owned()))?;
        let time_base = track
            .time_base
            .or_else(|| TimeBase::try_from_recip(sample_rate))
            .ok_or_else(|| AppError::Audio("Audio time base is unknown".to_owned()))?;
        let duration_ms = track
            .duration
            .map(|duration| {
                time_base
                    .calc_time_saturating(Timestamp::new(duration.get() as i64))
                    .as_millis() as u64
            })
            .or_else(|| {
                track
                    .num_frames
                    .map(|frames| frames.saturating_mul(1_000) / u64::from(sample_rate))
            })
            .ok_or_else(|| AppError::Audio("Audio duration is unknown".to_owned()))?;
        if duration_ms > MAX_DURATION_MS {
            return Err(AppError::Audio(
                "Audio exceeds the 30-minute limit".to_owned(),
            ));
        }
        let total_frames = track.num_frames.unwrap_or_else(|| {
            (time_base
                .calc_time_saturating(Timestamp::new(
                    track.duration.unwrap_or_default().get() as i64
                ))
                .as_secs_f64()
                * f64::from(sample_rate))
            .round() as u64
        });
        if total_frames == 0 {
            return Err(AppError::Audio(
                "Audio contains no playable frames".to_owned(),
            ));
        }
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(audio_error)?;

        Ok(Self {
            format,
            decoder,
            track_id,
            time_base,
            identity: AudioIdentity {
                canonical_path: canonical.to_string_lossy().into_owned(),
                size: metadata.len(),
                modified_ms,
                duration_ms,
                sample_rate,
                channels,
            },
            total_frames,
            next_frame: 0,
            pending: None,
        })
    }

    pub fn identity(&self) -> &AudioIdentity {
        &self.identity
    }

    fn timestamp_frame(&self, timestamp: symphonia::core::units::Timestamp) -> u64 {
        (self.time_base.calc_time_saturating(timestamp).as_secs_f64()
            * f64::from(self.identity.sample_rate))
        .round() as u64
    }

    fn decode_packet(&mut self) -> Result<Option<DecodedChunk>, AppError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(None),
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(audio_error(error)),
            };
            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = self.decoder.decode(&packet).map_err(audio_error)?;
            let channels = decoded.spec().channels().count() as u16;
            if channels == 0 {
                return Err(AppError::Audio("Decoded audio has no channels".to_owned()));
            }
            let mut interleaved = Vec::new();
            decoded.copy_to_vec_interleaved(&mut interleaved);
            let frame_count = interleaved.len() as u64 / u64::from(channels);
            if frame_count == 0 {
                continue;
            }
            let start_frame = self.next_frame;
            self.next_frame = self.next_frame.saturating_add(frame_count);
            return Ok(Some(DecodedChunk {
                start_frame,
                channels,
                interleaved,
            }));
        }
    }

    pub fn seek_exact(&mut self, target_frame: u64) -> Result<(), AppError> {
        if target_frame >= self.total_frames {
            return Err(AppError::Audio("Seek exceeds audio duration".to_owned()));
        }
        let nanos = u128::from(target_frame)
            .saturating_mul(1_000_000_000)
            .checked_div(u128::from(self.identity.sample_rate))
            .ok_or_else(|| AppError::Audio("Seek time overflow".to_owned()))?;
        let time = Time::try_from_nanos_u128(nanos)
            .ok_or_else(|| AppError::Audio("Seek time overflow".to_owned()))?;
        let sought = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(audio_error)?;
        self.decoder.reset();
        self.pending = None;
        self.next_frame = self.timestamp_frame(sought.actual_ts);
        if self.next_frame > target_frame {
            return Err(AppError::Audio(
                "Decoder seek passed the requested frame".to_owned(),
            ));
        }

        loop {
            let chunk = self
                .decode_packet()?
                .ok_or_else(|| AppError::Audio("Seek reached end of audio".to_owned()))?;
            let frame_count = chunk.interleaved.len() as u64 / u64::from(chunk.channels);
            let chunk_end = chunk.start_frame.saturating_add(frame_count);
            if target_frame >= chunk_end {
                continue;
            }
            if target_frame < chunk.start_frame {
                return Err(AppError::Audio(
                    "Decoder produced a gap after seek".to_owned(),
                ));
            }
            let sample_offset =
                (target_frame - chunk.start_frame) as usize * chunk.channels as usize;
            self.pending = Some(DecodedChunk {
                start_frame: target_frame,
                channels: chunk.channels,
                interleaved: chunk.interleaved[sample_offset..].to_vec(),
            });
            return Ok(());
        }
    }

    pub fn decode_next(&mut self) -> Result<Option<DecodedChunk>, AppError> {
        if let Some(pending) = self.pending.take() {
            return Ok(Some(pending));
        }
        self.decode_packet()
    }

    pub fn decode_range(
        &mut self,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<DecodedChunk, AppError> {
        if end_frame <= start_frame {
            return Err(AppError::Audio("Decode range must be non-empty".to_owned()));
        }
        if start_frame >= self.total_frames || end_frame > self.total_frames {
            return Err(AppError::Audio(
                "Decode range exceeds audio duration".to_owned(),
            ));
        }
        self.seek_exact(start_frame)?;
        let channels = self.identity.channels;
        let wanted_samples = (end_frame - start_frame) as usize * channels as usize;
        let mut interleaved = Vec::with_capacity(wanted_samples);
        while interleaved.len() < wanted_samples {
            let chunk = self
                .decode_next()?
                .ok_or_else(|| AppError::Audio("Range exceeds audio".to_owned()))?;
            if chunk.channels != channels {
                return Err(AppError::Audio(
                    "Audio channel count changed while decoding".to_owned(),
                ));
            }
            let remaining = wanted_samples - interleaved.len();
            if chunk.interleaved.len() > remaining {
                interleaved.extend_from_slice(&chunk.interleaved[..remaining]);
                self.pending = Some(DecodedChunk {
                    start_frame: chunk.start_frame + (remaining / channels as usize) as u64,
                    channels,
                    interleaved: chunk.interleaved[remaining..].to_vec(),
                });
            } else {
                interleaved.extend_from_slice(&chunk.interleaved);
            }
        }
        Ok(DecodedChunk {
            start_frame,
            channels,
            interleaved,
        })
    }
}

fn audio_error(error: impl std::fmt::Display) -> AppError {
    AppError::Audio(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3")
    }

    #[test]
    fn probes_the_committed_mp3_fixture() {
        let decoder = AudioDecoder::open(&fixture()).unwrap();
        assert!(decoder.identity().duration_ms > 0);
        assert!(decoder.identity().sample_rate > 0);
        assert!(decoder.identity().channels > 0);
    }

    #[test]
    fn exact_seek_matches_the_same_frames_from_sequential_decode() {
        let mut sequential = AudioDecoder::open(&fixture()).unwrap();
        let decoded_from_zero = sequential.decode_range(0, 2_128).unwrap();
        let channels = decoded_from_zero.channels as usize;
        let expected = decoded_from_zero.interleaved[2_000 * channels..2_128 * channels].to_vec();

        let mut sought = AudioDecoder::open(&fixture()).unwrap();
        let actual = sought.decode_range(2_000, 2_128).unwrap();

        assert_eq!(actual.start_frame, 2_000);
        assert_eq!(actual.interleaved.len(), expected.len());
        for (left, right) in actual.interleaved.iter().zip(expected) {
            assert!((left - right).abs() < 1e-6);
        }
    }

    #[test]
    fn wav_ranges_are_frame_addressed_and_bounds_checked() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("frames.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 1_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for value in 0_i16..10 {
            writer.write_sample(value).unwrap();
        }
        writer.finalize().unwrap();

        let mut decoder = AudioDecoder::open(&path).unwrap();
        let range = decoder.decode_range(8, 10).unwrap();
        assert_eq!(range.start_frame, 8);
        assert_eq!(range.interleaved.len(), 2);
        assert!(decoder.decode_range(10, 10).is_err());
        assert!(decoder.decode_range(9, 11).is_err());
    }
}
