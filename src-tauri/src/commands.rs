use crate::{
    audio::{decoder::AudioDecoder, peaks},
    error::AppError,
    model::{AudioIdentity, MultilinePolicy, PeakData, Project},
    persistence,
    tsv::{self, ImportedTsv},
};
use atomic_write_file::AtomicWriteFile;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AnalysisState {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

impl AnalysisState {
    fn begin(&self) -> Result<Arc<AtomicBool>, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::Audio("Analysis state lock poisoned".to_owned()))?;
        let current = Arc::new(AtomicBool::new(false));
        if let Some(previous) = active.replace(current.clone()) {
            previous.store(true, Ordering::Release);
        }
        Ok(current)
    }

    fn cancel(&self) -> Result<(), AppError> {
        if let Some(active) = self
            .active
            .lock()
            .map_err(|_| AppError::Audio("Analysis state lock poisoned".to_owned()))?
            .as_ref()
        {
            active.store(true, Ordering::Release);
        }
        Ok(())
    }
}

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

#[tauri::command]
pub async fn inspect_audio(path: String) -> Result<AudioIdentity, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        AudioDecoder::open(Path::new(&path)).map(|decoder| decoder.identity().clone())
    })
    .await
    .map_err(|error| AppError::Audio(error.to_string()))?
}

#[tauri::command]
pub async fn analyze_audio(
    app: AppHandle,
    state: State<'_, AnalysisState>,
    path: String,
) -> Result<PeakData, AppError> {
    let cancelled = state.begin()?;
    let cache_dir = app_data(&app)?.join("cache");
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&path);
        let identity = AudioDecoder::open(source)?.identity().clone();
        if let Some(cached) = peaks::read_cache(&cache_dir, &identity)? {
            return Ok::<PeakData, AppError>(cached);
        }
        let progress_app = app.clone();
        let data = peaks::analyze_path(source, &cancelled, |value| {
            let _ = progress_app.emit("analysis-progress", value);
        })?;
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::Audio("Waveform analysis cancelled".to_owned()));
        }
        peaks::write_cache(&cache_dir, &identity, &data)?;
        Ok::<PeakData, AppError>(data)
    })
    .await
    .map_err(|error| AppError::Audio(error.to_string()))?
}

#[tauri::command]
pub fn cancel_analysis(state: State<'_, AnalysisState>) -> Result<(), AppError> {
    state.cancel()
}
