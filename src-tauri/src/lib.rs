pub mod audio;
mod commands;
#[cfg(test)]
mod configuration_tests;
pub mod error;
pub mod model;
pub mod persistence;
pub mod tsv;

pub use commands::write_project_tsv_export_to_path;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AnalysisState::default())
        .manage(Mutex::new(audio::engine::AudioEngine::new()))
        .invoke_handler(tauri::generate_handler![
            commands::save_project,
            commands::load_project,
            commands::read_tsv,
            commands::write_tsv,
            commands::inspect_audio,
            commands::analyze_audio,
            commands::cancel_analysis,
            commands::audio_open,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_seek,
            commands::audio_set_loop,
            commands::audio_clear_loop,
            commands::audio_set_volume,
            commands::audio_snapshot,
            commands::audio_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lightscribe");
}
