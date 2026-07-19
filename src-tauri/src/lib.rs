pub mod audio;
mod commands;
#[cfg(test)]
mod configuration_tests;
pub mod error;
pub mod model;
pub mod persistence;
pub mod tsv;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AnalysisState::default())
        .invoke_handler(tauri::generate_handler![
            commands::save_project,
            commands::load_project,
            commands::read_tsv,
            commands::write_tsv,
            commands::inspect_audio,
            commands::analyze_audio,
            commands::cancel_analysis
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lightscribe");
}
