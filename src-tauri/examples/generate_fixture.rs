fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Tauri crate has a project root");
    let path = root.join("tests/fixtures/annotation-audio-test.wav");
    std::fs::create_dir_all(path.parent().expect("fixture has a parent"))
        .expect("create fixture directory");

    let specification = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, specification).expect("create WAV fixture");
    for frame in 0..480_000_u64 {
        let sample = if frame == 48_000 || frame == 96_000 {
            i16::MAX
        } else {
            ((frame as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 2_000.0) as i16
        };
        writer.write_sample(sample).expect("write WAV sample");
    }
    writer.finalize().expect("finalize WAV fixture");
}
