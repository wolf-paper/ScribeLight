use scribelight_lib::{
    audio::{
        decoder::AudioDecoder,
        engine::ring_capacity_frames,
        loop_cursor::{LoopCursor, LoopRange},
        peaks::{analyze_path, cache_path, read_cache, write_cache},
    },
    model::{
        Annotation, AnnotationDraft, AudioIdentity, Confidence, EventType, ExportSettings,
        Intelligibility, LabelDefinition, MultilinePolicy, Overlap, Project, TimeDisplayFormat,
    },
    tsv::{export_tsv, parse_tsv, write_tsv_to_path},
    write_project_tsv_export_to_path,
};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Tauri crate has a project root")
        .join("tests/fixtures")
        .join(name)
}

fn source_digest(path: &Path) -> (u64, blake3::Hash) {
    let bytes = std::fs::read(path).expect("read source fixture");
    (bytes.len() as u64, blake3::hash(&bytes))
}

fn reopen_peak_data(source: &Path, cache_dir: &Path) -> scribelight_lib::model::PeakData {
    let identity = AudioDecoder::open(source)
        .expect("inspect source while reopening")
        .identity()
        .clone();
    if let Some(cached) = read_cache(cache_dir, &identity).expect("read derived peak cache") {
        return cached;
    }

    let regenerated = analyze_path(source, &AtomicBool::new(false), |_| {})
        .expect("regenerate derived peak cache");
    write_cache(cache_dir, &identity, &regenerated).expect("atomically replace derived peak cache");
    regenerated
}

fn populated_export_project(identity: AudioIdentity) -> Project {
    Project {
        schema_version: 1,
        audio_identity: identity,
        display_format: TimeDisplayFormat::Seconds,
        speakers: vec![LabelDefinition {
            id: "speaker-narrator".into(),
            label: "narrator".into(),
        }],
        acoustic_tags: vec![LabelDefinition {
            id: "tag-whisper".into(),
            label: "whisper".into(),
        }],
        annotations: vec![Annotation {
            id: "annotation-export".into(),
            start_ms: 3_000,
            end_ms: 4_000,
            event_type: EventType::Speech,
            transcription: "もう一度\nお願いします".into(),
            intelligibility: Intelligibility::HighlyIntelligible,
            speaker_id: Some("speaker-narrator".into()),
            overlap: Overlap::Overlap,
            confidence: Confidence::High,
            acoustic_tag_ids: vec!["tag-whisper".into()],
            notes: "確認\n済み".into(),
            created_at: "2026-07-19T00:00:00.000Z".into(),
            updated_at: "2026-07-19T00:00:00.000Z".into(),
        }],
        draft: AnnotationDraft {
            start_ms: 0,
            end_ms: 0,
            event_type: EventType::Speech,
            transcription: String::new(),
            intelligibility: Intelligibility::HighlyIntelligible,
            speaker_id: Some("speaker-narrator".into()),
            overlap: Overlap::None,
            confidence: Confidence::High,
            acoustic_tag_ids: vec![],
            notes: String::new(),
        },
        active_annotation_id: Some("annotation-export".into()),
        active_selection: None,
        export_settings: ExportSettings {
            multiline_policy: MultilinePolicy::Escape,
        },
    }
}

#[test]
fn wav_impulses_and_loop_wrap_preserve_end_exclusive_source_frames() {
    let path = fixture("annotation-audio-test.wav");
    let mut decoder = AudioDecoder::open(&path).expect("open deterministic WAV");
    let decoded = decoder
        .decode_range(47_990, 96_010)
        .expect("decode across both impulses");
    let channels = usize::from(decoded.channels);
    let at = |frame: u64| decoded.interleaved[((frame - decoded.start_frame) as usize) * channels];

    assert!(at(48_000) > 0.99, "first impulse must be at frame 48,000");
    assert!(at(96_000) > 0.99, "second impulse must be at frame 96,000");

    let loop_audio = AudioDecoder::open(&path)
        .expect("reopen WAV")
        .decode_range(48_000, 96_000)
        .expect("decode end-exclusive loop range");
    assert_eq!(loop_audio.interleaved.len() / channels, 48_000);
    assert_eq!(
        loop_audio
            .interleaved
            .chunks_exact(channels)
            .filter(|frame| frame[0] > 0.99)
            .count(),
        1,
        "the end impulse must not be included in [48,000, 96,000)"
    );

    let mut cursor = LoopCursor::new(
        95_998,
        Some(LoopRange::new(48_000, 96_000).expect("valid loop")),
    );
    assert_eq!(
        (0..4).map(|_| cursor.take()).collect::<Vec<_>>(),
        vec![95_998, 95_999, 48_000, 48_001]
    );
}

#[test]
fn mp3_exact_seek_matches_sequential_decode() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3");
    let mut sequential = AudioDecoder::open(&path).expect("open MP3 baseline");
    let channels = usize::from(sequential.identity().channels);
    let mut from_zero = Vec::new();
    while from_zero.len() < 3_256 * channels {
        let chunk = sequential
            .decode_next()
            .expect("decode sequential MP3")
            .expect("MP3 has enough frames");
        from_zero.extend_from_slice(&chunk.interleaved);
    }
    let expected = &from_zero[3_000 * channels..3_256 * channels];

    let actual = AudioDecoder::open(&path)
        .expect("reopen MP3")
        .decode_range(3_000, 3_256)
        .expect("seek and decode MP3 range");
    assert_eq!(actual.start_frame, 3_000);
    assert_eq!(actual.interleaved.len(), expected.len());
    assert!(
        actual
            .interleaved
            .iter()
            .zip(expected)
            .all(|(left, right)| (left - right).abs() < 1e-6),
        "exact seek samples differ from sequential decoding"
    );
}

#[test]
fn mp3_peak_cache_frame_extent_matches_its_inspected_duration() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3");
    let cache = tempfile::tempdir().expect("temporary MP3 peak cache");
    let identity = AudioDecoder::open(&path)
        .expect("inspect MP3 for cache identity")
        .identity()
        .clone();
    let peaks =
        analyze_path(&path, &AtomicBool::new(false), |_| {}).expect("analyze MP3 peak data");

    write_cache(cache.path(), &identity, &peaks).expect("write MP3 peak cache");
    assert_eq!(
        read_cache(cache.path(), &identity).expect("read MP3 peak cache"),
        Some(peaks)
    );
}

#[test]
fn peak_cache_key_invalidates_after_source_size_or_mtime_changes() {
    let directory = tempfile::tempdir().expect("temporary cache directory");

    let size_source = directory.path().join("size.wav");
    std::fs::copy(fixture("annotation-audio-test.wav"), &size_source).expect("copy WAV");
    let size_before = AudioDecoder::open(&size_source)
        .expect("inspect size source")
        .identity()
        .clone();
    let size_key = cache_path(directory.path(), &size_before);
    let peaks =
        analyze_path(&size_source, &AtomicBool::new(false), |_| {}).expect("analyze copied WAV");
    write_cache(directory.path(), &size_before, &peaks).expect("write source cache");
    assert_eq!(
        read_cache(directory.path(), &size_before).unwrap(),
        Some(peaks)
    );
    OpenOptions::new()
        .append(true)
        .open(&size_source)
        .expect("open source for append")
        .write_all(&[0])
        .expect("change source size");
    let size_after = AudioDecoder::open(&size_source)
        .expect("inspect size-changed source")
        .identity()
        .clone();
    assert_ne!(size_before.size, size_after.size);
    assert_ne!(size_key, cache_path(directory.path(), &size_after));
    assert_eq!(read_cache(directory.path(), &size_after).unwrap(), None);

    let mtime_source = directory.path().join("mtime.wav");
    std::fs::copy(fixture("annotation-audio-test.wav"), &mtime_source).expect("copy WAV");
    let mtime_before = AudioDecoder::open(&mtime_source)
        .expect("inspect mtime source")
        .identity()
        .clone();
    std::thread::sleep(Duration::from_millis(2));
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&mtime_source)
        .expect("open source for same-size write");
    file.seek(SeekFrom::End(-1)).expect("seek to final byte");
    let mut byte = [0];
    file.read_exact(&mut byte).expect("read final byte");
    file.seek(SeekFrom::End(-1)).expect("rewind final byte");
    file.write_all(&byte).expect("rewrite final byte");
    file.sync_all().expect("flush mtime change");
    drop(file);
    let mtime_after = AudioDecoder::open(&mtime_source)
        .expect("inspect mtime-changed source")
        .identity()
        .clone();
    assert_eq!(mtime_before.size, mtime_after.size);
    assert_ne!(mtime_before.modified_ms, mtime_after.modified_ms);
    assert_ne!(
        cache_path(directory.path(), &mtime_before),
        cache_path(directory.path(), &mtime_after)
    );
}

#[test]
fn corrupt_truncated_and_invalid_peak_caches_regenerate_when_audio_reopens() {
    let directory = tempfile::tempdir().expect("temporary analysis directory");
    let source = directory.path().join("cache-recovery.wav");
    std::fs::copy(fixture("annotation-audio-test.wav"), &source).expect("copy WAV fixture");
    let cache_dir = directory.path().join("cache");
    let identity = AudioDecoder::open(&source)
        .expect("inspect copied source")
        .identity()
        .clone();
    let expected =
        analyze_path(&source, &AtomicBool::new(false), |_| {}).expect("establish expected peaks");
    let cache_file = cache_path(&cache_dir, &identity);
    std::fs::create_dir_all(&cache_dir).expect("create cache directory");

    let invalid_shape = scribelight_lib::model::PeakData {
        duration_ms: identity.duration_ms + 1,
        ..expected.clone()
    };
    let coherently_truncated = scribelight_lib::model::PeakData {
        total_frames: 1,
        duration_ms: identity.duration_ms,
        sample_rate: identity.sample_rate,
        frames_per_peak: expected.frames_per_peak,
        channels: vec![vec![0.0, 0.0]; usize::from(identity.channels)],
    };
    let broken_caches = [
        b"{\"totalFrames\":".to_vec(),
        br#"{"schemaVersion":999}"#.to_vec(),
        serde_json::to_vec(&invalid_shape).expect("serialize invalid peak shape"),
        serde_json::to_vec(&coherently_truncated)
            .expect("serialize coherently truncated peak cache"),
    ];

    for broken in broken_caches {
        std::fs::write(&cache_file, broken).expect("install broken cache");

        let reopened = reopen_peak_data(&source, &cache_dir);

        assert_eq!(reopened, expected);
        assert_eq!(
            read_cache(&cache_dir, &identity).expect("read regenerated cache"),
            Some(expected.clone())
        );
        let persisted: scribelight_lib::model::PeakData = serde_json::from_slice(
            &std::fs::read(&cache_file).expect("read regenerated cache bytes"),
        )
        .expect("regenerated cache contains valid JSON");
        assert_eq!(persisted, expected);
    }
}

#[test]
fn thirty_minute_analysis_bounds_peak_pairs_and_pcm_ring_to_one_second() {
    let directory = tempfile::tempdir().expect("temporary fixture directory");
    let path = directory.path().join("thirty-minutes.wav");
    let specification = hound::WavSpec {
        channels: 1,
        sample_rate: 1_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&path, specification).expect("create long WAV");
    for _ in 0..1_800_000 {
        writer.write_sample(0_i16).expect("write silence");
    }
    writer.finalize().expect("finalize long WAV");

    let peaks =
        analyze_path(&path, &AtomicBool::new(false), |_| {}).expect("analyze maximum-duration WAV");
    assert_eq!(peaks.total_frames, 1_800_000);
    assert_eq!(peaks.channels.len(), 1);
    assert!(
        peaks.channels[0].len() / 2 <= 1_800 * 100,
        "peak storage exceeded 100 min/max pairs per second per channel"
    );
    assert!(
        ring_capacity_frames(peaks.sample_rate) <= peaks.sample_rate as usize,
        "PCM ring exceeded one second of source frames"
    );
}

#[test]
fn production_tsv_export_writes_exact_populated_utf8_bytes_and_round_trips() {
    let source = fixture("annotation-audio-test.wav");
    let identity = AudioDecoder::open(&source)
        .expect("inspect source identity")
        .identity()
        .clone();
    let project = populated_export_project(identity);
    let directory = tempfile::tempdir().expect("temporary export directory");
    let output = directory.path().join("renamed-labels.TSV");
    let expected = concat!(
        "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n",
        "3.000\t4.000\tspeech\tもう一度\\nお願いします\thighly_intelligible\tnarrator\toverlap\thigh\twhisper\t確認\\n済み\n"
    );

    assert_eq!(
        export_tsv(&project).expect("serialize populated project"),
        expected
    );
    write_project_tsv_export_to_path(&output, &project)
        .expect("safely and atomically write populated TSV");
    assert_eq!(
        std::fs::read(&output).expect("read exported TSV"),
        expected.as_bytes()
    );

    let parsed = parse_tsv(
        &std::fs::read_to_string(&output).expect("read UTF-8 TSV"),
        MultilinePolicy::Escape,
    )
    .expect("parse exported TSV");
    assert_eq!(parsed.annotations.len(), 1);
    assert_eq!(parsed.annotations[0].start_ms, 3_000);
    assert_eq!(parsed.annotations[0].end_ms, 4_000);
    assert_eq!(
        parsed.annotations[0].transcription,
        "もう一度\nお願いします"
    );
    assert_eq!(parsed.annotations[0].speaker.as_deref(), Some("narrator"));
    assert_eq!(parsed.annotations[0].overlap, Overlap::Overlap);
    assert_eq!(parsed.annotations[0].acoustic_tags, vec!["whisper"]);
    assert_eq!(parsed.annotations[0].notes, "確認\n済み");
}

#[test]
fn production_tsv_export_rejects_source_aliases_and_non_tsv_destinations() {
    let directory = tempfile::tempdir().expect("temporary export directory");
    let source = directory.path().join("source-audio.tsv");
    std::fs::copy(fixture("annotation-audio-test.wav"), &source)
        .expect("copy WAV bytes under a TSV filename");
    let mut identity = AudioDecoder::open(&fixture("annotation-audio-test.wav"))
        .expect("inspect WAV fixture")
        .identity()
        .clone();
    identity.canonical_path = source
        .canonicalize()
        .expect("canonicalize copied source")
        .to_string_lossy()
        .into_owned();
    identity.size = std::fs::metadata(&source)
        .expect("read copied source metadata")
        .len();
    let project = populated_export_project(identity);
    let source_bytes = std::fs::read(&source).expect("read original source bytes");
    let source_before = source_digest(&source);
    let alias_component = directory.path().join("existing-directory");
    std::fs::create_dir(&alias_component).expect("create alias path component");
    let source_alias = alias_component.join("..").join("source-audio.tsv");

    let alias_error = write_project_tsv_export_to_path(&source_alias, &project)
        .expect_err("source alias must never be replaced by TSV output");
    assert!(alias_error.to_string().contains("source audio"));
    assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    assert_eq!(source_digest(&source), source_before);

    let non_tsv = directory.path().join("annotations.txt");
    let non_tsv_bytes = b"existing non-TSV content";
    std::fs::write(&non_tsv, non_tsv_bytes).expect("create existing non-TSV destination");
    let extension_error = write_project_tsv_export_to_path(&non_tsv, &project)
        .expect_err("non-TSV export path must be rejected");
    assert!(extension_error.to_string().contains(".tsv"));
    assert_eq!(std::fs::read(&non_tsv).unwrap(), non_tsv_bytes);
    assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
    assert_eq!(source_digest(&source), source_before);
}

#[cfg(windows)]
#[test]
fn production_tsv_export_rejects_a_hard_link_alias_to_the_source_audio() {
    let directory = tempfile::tempdir().expect("temporary hard-link export directory");
    let source = directory.path().join("source-audio.wav");
    std::fs::copy(fixture("annotation-audio-test.wav"), &source).expect("copy WAV source");
    let destination = directory.path().join("source-hard-link.tsv");
    std::fs::hard_link(&source, &destination).expect("create hard-link destination alias");
    let identity = AudioDecoder::open(&source)
        .expect("inspect copied WAV source")
        .identity()
        .clone();
    let project = populated_export_project(identity);
    let original_bytes = std::fs::read(&source).expect("read original source bytes");
    let original_digest = source_digest(&source);
    assert_eq!(source_digest(&destination), original_digest);

    let error = write_project_tsv_export_to_path(&destination, &project)
        .expect_err("hard-link source alias must not be replaced by TSV output");

    assert!(matches!(
        error,
        scribelight_lib::error::AppError::Tsv(message) if message.contains("source audio")
    ));
    assert_eq!(std::fs::read(&source).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&destination).unwrap(), original_bytes);
    assert_eq!(source_digest(&source), original_digest);
    assert_eq!(source_digest(&destination), original_digest);
}

#[test]
fn analysis_import_and_export_leave_source_hash_size_and_directory_unchanged() {
    let path = fixture("annotation-audio-test.wav");
    let before = source_digest(&path);
    let adjacent_before = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();

    let peaks = analyze_path(&path, &AtomicBool::new(false), |_| {}).expect("analyze fixture");
    let imported_text = std::fs::read_to_string(fixture("pass-a.annotation.private.tsv"))
        .expect("read literal UTF-8 TSV");
    let imported = parse_tsv(&imported_text, MultilinePolicy::Escape).expect("import TSV");
    assert_eq!(imported.annotations[0].transcription, "待って");
    assert_eq!(imported.annotations[1].transcription, "はい");

    let identity = AudioIdentity {
        canonical_path: path.canonicalize().unwrap().to_string_lossy().into_owned(),
        size: before.0,
        modified_ms: AudioDecoder::open(&path).unwrap().identity().modified_ms,
        duration_ms: peaks.duration_ms,
        sample_rate: peaks.sample_rate,
        channels: peaks.channels.len() as u16,
    };
    let project = populated_export_project(identity);
    let export_directory = tempfile::tempdir().expect("temporary export directory");
    write_tsv_to_path(
        &export_directory.path().join("source-preservation.tsv"),
        &project,
    )
    .expect("write populated portable TSV away from source audio");

    assert_eq!(source_digest(&path), before, "source WAV bytes changed");
    let adjacent_after = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(
        adjacent_after, adjacent_before,
        "analysis created adjacent metadata"
    );
    assert!(!path.with_extension("json").exists());
}
