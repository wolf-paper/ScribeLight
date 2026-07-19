use crate::{
    audio::decoder::AudioDecoder,
    error::AppError,
    model::{AnalysisProgress, AudioIdentity, PeakData},
};
use atomic_write_file::AtomicWriteFile;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub fn analyze_path(
    path: &Path,
    cancelled: &AtomicBool,
    progress: impl FnMut(AnalysisProgress),
) -> Result<PeakData, AppError> {
    let mut decoder = AudioDecoder::open(path)?;
    analyze_decoder(&mut decoder, cancelled, progress)
}

pub fn analyze_decoder(
    decoder: &mut AudioDecoder,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(AnalysisProgress),
) -> Result<PeakData, AppError> {
    let identity = decoder.identity().clone();
    let channels = identity.channels as usize;
    let frames_per_peak = (identity.sample_rate / 100).max(1);
    let mut output = vec![Vec::new(); channels];
    let mut minimum = vec![f32::INFINITY; channels];
    let mut maximum = vec![f32::NEG_INFINITY; channels];
    let mut bucket_frames = 0_u32;
    let mut processed_frames = 0_u64;
    let mut last_report = Instant::now() - Duration::from_millis(100);

    while let Some(chunk) = decoder.decode_next()? {
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::Audio("Waveform analysis cancelled".to_owned()));
        }
        for frame in chunk.interleaved.chunks_exact(channels) {
            if cancelled.load(Ordering::Acquire) {
                return Err(AppError::Audio("Waveform analysis cancelled".to_owned()));
            }
            for (channel, sample) in frame.iter().enumerate() {
                minimum[channel] = minimum[channel].min(*sample);
                maximum[channel] = maximum[channel].max(*sample);
            }
            bucket_frames += 1;
            processed_frames += 1;
            if bucket_frames == frames_per_peak {
                flush_bucket(&mut output, &mut minimum, &mut maximum);
                bucket_frames = 0;
            }
        }
        if last_report.elapsed() >= Duration::from_millis(100) {
            let processed_ms =
                processed_frames.saturating_mul(1_000) / u64::from(identity.sample_rate);
            if processed_ms < identity.duration_ms {
                progress(AnalysisProgress {
                    processed_ms,
                    duration_ms: identity.duration_ms,
                });
            }
            last_report = Instant::now();
        }
    }
    if bucket_frames > 0 {
        flush_bucket(&mut output, &mut minimum, &mut maximum);
    }
    Ok(PeakData {
        total_frames: processed_frames,
        duration_ms: identity.duration_ms,
        sample_rate: identity.sample_rate,
        frames_per_peak,
        channels: output,
    })
}

fn flush_bucket(output: &mut [Vec<f32>], minimum: &mut [f32], maximum: &mut [f32]) {
    for channel in 0..output.len() {
        output[channel].push(minimum[channel].clamp(-1.0, 1.0));
        output[channel].push(maximum[channel].clamp(-1.0, 1.0));
        minimum[channel] = f32::INFINITY;
        maximum[channel] = f32::NEG_INFINITY;
    }
}

pub fn cache_path(cache_dir: &Path, identity: &AudioIdentity) -> PathBuf {
    let material = format!(
        "{}\0{}\0{}",
        identity.canonical_path, identity.size, identity.modified_ms
    );
    cache_dir.join(format!(
        "{}.json",
        blake3::hash(material.as_bytes()).to_hex()
    ))
}

pub fn read_cache(
    cache_dir: &Path,
    identity: &AudioIdentity,
) -> Result<Option<PeakData>, AppError> {
    let path = cache_path(cache_dir, identity);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let peaks: PeakData = match serde_json::from_slice(&bytes) {
        Ok(peaks) => peaks,
        Err(_) => return Ok(None),
    };
    if validate_cache(&peaks, identity).is_err() {
        return Ok(None);
    }
    Ok(Some(peaks))
}

fn validate_cache(peaks: &PeakData, identity: &AudioIdentity) -> Result<(), AppError> {
    let expected_fpp = (identity.sample_rate / 100).max(1);
    let expected_pairs = (peaks.total_frames as usize).div_ceil(expected_fpp as usize);
    let valid = peaks.duration_ms == identity.duration_ms
        && peaks.sample_rate == identity.sample_rate
        && peaks.total_frames > 0
        && peaks.total_frames <= u64::from(identity.sample_rate) * 30 * 60
        && peaks.frames_per_peak == expected_fpp
        && peaks.channels.len() == usize::from(identity.channels)
        && peaks.channels.iter().all(|channel| {
            !channel.is_empty()
                && channel.len() % 2 == 0
                && channel.len() / 2 == expected_pairs
                && channel
                    .iter()
                    .all(|value| value.is_finite() && (-1.0..=1.0).contains(value))
        });
    valid.then_some(()).ok_or_else(|| {
        AppError::Audio(
            "Invalid waveform cache: peak data does not match audio identity".to_owned(),
        )
    })
}

pub fn write_cache(
    cache_dir: &Path,
    identity: &AudioIdentity,
    peaks: &PeakData,
) -> Result<(), AppError> {
    fs::create_dir_all(cache_dir)?;
    let bytes = serde_json::to_vec(peaks).map_err(|error| AppError::Audio(error.to_string()))?;
    let mut file = AtomicWriteFile::options().open(cache_path(cache_dir, identity))?;
    file.write_all(&bytes)?;
    file.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::atomic::AtomicBool};

    fn write_wav(samples: &[i16], sample_rate: u32) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tone.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        (directory, path)
    }

    #[test]
    fn creates_clamped_min_max_buckets_and_flushes_the_final_partial_bucket() {
        let (_directory, path) = write_wav(
            &[
                0, 1_000, -2_000, 3_000, 0, -4_000, 2_000, 0, 1_000, -1_000, 32_767,
            ],
            1_000,
        );
        let peaks = analyze_path(&path, &AtomicBool::new(false), |_| {}).unwrap();

        assert_eq!(peaks.channels.len(), 1);
        assert_eq!(peaks.frames_per_peak, 10);
        assert_eq!(peaks.channels[0].len(), 4);
        assert!(peaks.channels[0]
            .iter()
            .all(|value| (-1.0..=1.0).contains(value)));
        assert!(peaks.channels[0][0] < 0.0);
        assert!(peaks.channels[0][1] > 0.0);
        assert!(peaks.channels[0][2] > 0.99);
        assert!(peaks.channels[0][3] > 0.99);
    }

    #[test]
    fn retains_only_bounded_peak_output_for_longer_input() {
        let samples = vec![1_000_i16; 250];
        let (_directory, path) = write_wav(&samples, 1_000);
        let peaks = analyze_path(&path, &AtomicBool::new(false), |_| {}).unwrap();

        assert_eq!(peaks.channels[0].len(), 50);
        assert!(peaks.channels[0].len() < samples.len());
    }

    #[test]
    fn reports_throttled_progress_but_not_completion_and_honors_cancellation() {
        let (_directory, path) = write_wav(&vec![1_000_i16; 250], 1_000);
        let mut progress = Vec::new();
        let peaks =
            analyze_path(&path, &AtomicBool::new(false), |event| progress.push(event)).unwrap();
        assert!(!peaks.channels[0].is_empty());
        assert!(progress
            .iter()
            .all(|event| event.processed_ms < event.duration_ms));

        let cancelled = AtomicBool::new(true);
        let error = analyze_path(&path, &cancelled, |_| {}).unwrap_err();
        assert!(error.to_string().contains("cancelled"));
    }

    #[test]
    fn cache_round_trips_and_source_identity_invalidates_it() {
        let (_directory, source) = write_wav(&[1_000_i16; 10], 1_000);
        let cache = tempfile::tempdir().unwrap();
        let identity = AudioDecoder::open(&source).unwrap().identity().clone();
        let peaks = analyze_path(&source, &AtomicBool::new(false), |_| {}).unwrap();

        write_cache(cache.path(), &identity, &peaks).unwrap();
        assert_eq!(read_cache(cache.path(), &identity).unwrap(), Some(peaks));

        let changed = crate::model::AudioIdentity {
            size: identity.size + 1,
            ..identity.clone()
        };
        assert_ne!(
            cache_path(cache.path(), &identity),
            cache_path(cache.path(), &changed)
        );
        assert_eq!(read_cache(cache.path(), &changed).unwrap(), None);
    }

    #[test]
    fn malformed_cache_is_a_miss_without_touching_the_source_audio() {
        let (_directory, source) = write_wav(&[1_000_i16; 10], 1_000);
        let cache = tempfile::tempdir().unwrap();
        let identity = AudioDecoder::open(&source).unwrap().identity().clone();
        std::fs::create_dir_all(cache.path()).unwrap();
        std::fs::write(cache_path(cache.path(), &identity), b"not json").unwrap();
        let original = std::fs::read(&source).unwrap();

        assert_eq!(read_cache(cache.path(), &identity).unwrap(), None);
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    #[test]
    fn syntactically_valid_cache_with_wrong_identity_or_peak_shape_is_a_miss() {
        let (_directory, source) = write_wav(&[1_000_i16; 10], 1_000);
        let cache = tempfile::tempdir().unwrap();
        let identity = AudioDecoder::open(&source).unwrap().identity().clone();
        let invalid = PeakData {
            total_frames: 1,
            duration_ms: identity.duration_ms + 1,
            sample_rate: identity.sample_rate,
            frames_per_peak: 0,
            channels: vec![vec![f32::NAN]],
        };
        std::fs::create_dir_all(cache.path()).unwrap();
        std::fs::write(
            cache_path(cache.path(), &identity),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();

        assert_eq!(read_cache(cache.path(), &identity).unwrap(), None);
    }

    #[test]
    fn rejects_semantically_invalid_but_valid_json_cache_shapes() {
        let (_directory, source) = write_wav(&[1_000_i16; 100], 1_000);
        let cache = tempfile::tempdir().unwrap();
        let identity = AudioDecoder::open(&source).unwrap().identity().clone();
        std::fs::create_dir_all(cache.path()).unwrap();
        let valid = PeakData {
            total_frames: 100,
            duration_ms: identity.duration_ms,
            sample_rate: identity.sample_rate,
            frames_per_peak: 10,
            channels: vec![vec![
                -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1,
                0.1, -0.1, 0.1, -0.1, 0.1,
            ]],
        };
        for invalid in [
            PeakData {
                frames_per_peak: 11,
                ..valid.clone()
            },
            PeakData {
                channels: vec![vec![]],
                ..valid.clone()
            },
            PeakData {
                channels: vec![vec![-0.1, 1.1]],
                ..valid.clone()
            },
        ] {
            std::fs::write(
                cache_path(cache.path(), &identity),
                serde_json::to_vec(&invalid).unwrap(),
            )
            .unwrap();
            assert_eq!(read_cache(cache.path(), &identity).unwrap(), None);
        }
    }

    #[test]
    fn cache_file_io_errors_are_not_silently_treated_as_misses() {
        let (_directory, source) = write_wav(&[1_000_i16; 10], 1_000);
        let cache = tempfile::tempdir().unwrap();
        let identity = AudioDecoder::open(&source).unwrap().identity().clone();
        let path = cache_path(cache.path(), &identity);
        std::fs::create_dir_all(&path).unwrap();

        let error = read_cache(cache.path(), &identity).unwrap_err();

        assert!(matches!(error, AppError::Io(_)));
    }
}
