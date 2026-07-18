use crate::{
    error::AppError,
    model::{MultilinePolicy, Project},
    persistence,
    tsv::{self, ImportedTsv},
};
use atomic_write_file::AtomicWriteFile;
use std::{io::Write, path::PathBuf};
use tauri::{AppHandle, Manager};

fn app_data(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

#[tauri::command]
pub fn save_project(app: AppHandle, project: Project) -> Result<(), AppError> {
    let path = persistence::project_path(&app_data(&app)?, &project.audio_identity.canonical_path);
    persistence::save_project_to(&path, &project)
}

#[tauri::command]
pub fn load_project(
    app: AppHandle,
    canonical_audio_path: String,
) -> Result<Option<Project>, AppError> {
    let path = persistence::project_path(&app_data(&app)?, &canonical_audio_path);
    if !path.exists() {
        return Ok(None);
    }
    persistence::load_project_from(&path).map(Some)
}

#[tauri::command]
pub fn read_tsv(path: String, multiline_policy: MultilinePolicy) -> Result<ImportedTsv, AppError> {
    let text = std::fs::read_to_string(path)?;
    tsv::parse_tsv(&text, multiline_policy)
}

#[tauri::command]
pub fn write_tsv(path: String, project: Project) -> Result<(), AppError> {
    let text = tsv::export_tsv(&project)?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(text.as_bytes())?;
    file.commit()?;
    Ok(())
}
