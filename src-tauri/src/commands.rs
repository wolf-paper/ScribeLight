use crate::{
    audio::{
        decoder::{metadata_modified_ms, AudioDecoder},
        engine::AudioEngine,
        peaks,
    },
    error::AppError,
    model::{AudioIdentity, MultilinePolicy, PeakData, PlaybackSnapshot, Project, Selection},
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

#[derive(Default, Clone)]
pub struct AnalysisState {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
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

    #[cfg(test)]
    fn may_publish(&self, generation: &Arc<AtomicBool>) -> Result<bool, AppError> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::Audio("Analysis state lock poisoned".to_owned()))?;
        Ok(!generation.load(Ordering::Acquire)
            && active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, generation)))
    }

    fn publish_if_current(
        &self,
        generation: &Arc<AtomicBool>,
        action: impl FnOnce(),
    ) -> Result<bool, AppError> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::Audio("Analysis state lock poisoned".to_owned()))?;
        if generation.load(Ordering::Acquire)
            || !active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, generation))
        {
            return Ok(false);
        }
        action();
        Ok(true)
    }

    fn finish_if_current(
        &self,
        generation: &Arc<AtomicBool>,
        action: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<bool, AppError> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::Audio("Analysis state lock poisoned".to_owned()))?;
        if generation.load(Ordering::Acquire)
            || !active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, generation))
        {
            return Ok(false);
        }
        action()?;
        Ok(true)
    }
}

#[cfg(test)]
mod analysis_state_tests {
    use super::*;

    #[test]
    fn superseded_and_cancelled_generations_cannot_publish_or_commit() {
        let state = AnalysisState::default();
        let first = state.begin().unwrap();
        assert!(state.may_publish(&first).unwrap());
        let second = state.begin().unwrap();
        assert!(!state.may_publish(&first).unwrap());
        assert!(state.may_publish(&second).unwrap());
        state.cancel().unwrap();
        assert!(!state.may_publish(&second).unwrap());
    }

    #[test]
    fn only_the_current_generation_can_finish_after_a_race() {
        let state = AnalysisState::default();
        let old = state.begin().unwrap();
        let current = state.begin().unwrap();
        assert!(!state.finish_if_current(&old, || Ok(())).unwrap());
        assert!(state.finish_if_current(&current, || Ok(())).unwrap());
    }

    #[test]
    fn publication_action_is_not_run_after_the_generation_is_superseded() {
        let state = AnalysisState::default();
        let generation = state.begin().unwrap();
        state.begin().unwrap();
        let mut called = false;
        assert!(!state
            .publish_if_current(&generation, || called = true)
            .unwrap());
        assert!(!called);
    }

    #[test]
    fn identity_comparison_rejects_a_replaced_source() {
        let initial = AudioIdentity {
            canonical_path: "a.wav".into(),
            size: 1,
            modified_ms: 1,
            duration_ms: 1,
            sample_rate: 1,
            channels: 1,
        };
        assert!(same_source_identity(&initial, &initial));
        assert!(!same_source_identity(
            &initial,
            &AudioIdentity {
                size: 2,
                ..initial.clone()
            }
        ));
    }

    #[test]
    fn restated_identity_detects_a_changed_temp_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");
        std::fs::write(&path, b"one").unwrap();
        let initial = source_identity(&path).unwrap();
        std::fs::write(&path, b"source changed").unwrap();
        assert!(!same_source_identity(
            &initial,
            &source_identity(&path).unwrap()
        ));
    }
}

fn app_data(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

fn same_source_identity(left: &AudioIdentity, right: &AudioIdentity) -> bool {
    left.canonical_path == right.canonical_path
        && left.size == right.size
        && left.modified_ms == right.modified_ms
}

fn source_identity(path: &Path) -> Result<AudioIdentity, AppError> {
    let canonical = path.canonicalize()?;
    let metadata = std::fs::metadata(&canonical)?;
    let modified_ms = metadata_modified_ms(&metadata)?;
    Ok(AudioIdentity {
        canonical_path: canonical.to_string_lossy().into_owned(),
        size: metadata.len(),
        modified_ms,
        duration_ms: 0,
        sample_rate: 0,
        channels: 0,
    })
}

fn ensure_source_unchanged(path: &Path, original: &AudioIdentity) -> Result<(), AppError> {
    if same_source_identity(original, &source_identity(path)?) {
        Ok(())
    } else {
        Err(AppError::Audio(
            "Source audio changed during analysis; retry the operation".to_owned(),
        ))
    }
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
        let mut decoder = AudioDecoder::open(Path::new(&path))?;
        if Path::new(&path)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
        {
            decoder.verify_duration_to_end()?;
        }
        Ok::<AudioIdentity, AppError>(decoder.identity().clone())
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
    let state = state.inner().clone();
    let cache_dir = app_data(&app)?.join("cache");
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&path);
        let mut decoder = AudioDecoder::open(source)?;
        let identity = decoder.identity().clone();
        if let Some(cached) = peaks::read_cache(&cache_dir, &identity)? {
            ensure_source_unchanged(source, &identity)?;
            if state.finish_if_current(&cancelled, || Ok(()))? {
                return Ok::<PeakData, AppError>(cached);
            }
            return Err(AppError::Audio("Waveform analysis cancelled".to_owned()));
        }
        let progress_app = app.clone();
        let progress_state = state.clone();
        let data = peaks::analyze_decoder(&mut decoder, &cancelled, |value| {
            let _ = progress_state.publish_if_current(&cancelled, || {
                let _ = progress_app.emit("analysis-progress", value);
            });
        })?;
        let final_app = app.clone();
        if !state.finish_if_current(&cancelled, || {
            ensure_source_unchanged(source, &identity)?;
            peaks::write_cache(&cache_dir, &identity, &data)?;
            let _ = final_app.emit(
                "analysis-progress",
                crate::model::AnalysisProgress {
                    processed_ms: identity.duration_ms,
                    duration_ms: identity.duration_ms,
                },
            );
            Ok(())
        })? {
            return Err(AppError::Audio("Waveform analysis cancelled".to_owned()));
        }
        Ok::<PeakData, AppError>(data)
    })
    .await
    .map_err(|error| AppError::Audio(error.to_string()))?
}

#[tauri::command]
pub fn cancel_analysis(state: State<'_, AnalysisState>) -> Result<(), AppError> {
    state.cancel()
}

#[tauri::command]
pub fn audio_open(
    state: State<'_, Mutex<AudioEngine>>,
    path: String,
) -> Result<AudioIdentity, AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .open(Path::new(&path))
}

#[tauri::command]
pub fn audio_play(state: State<'_, Mutex<AudioEngine>>) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .play()
}

#[tauri::command]
pub fn audio_pause(state: State<'_, Mutex<AudioEngine>>) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .pause()
}

#[tauri::command]
pub fn audio_seek(state: State<'_, Mutex<AudioEngine>>, milliseconds: u64) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .seek_ms(milliseconds)
}

#[tauri::command]
pub fn audio_set_loop(
    state: State<'_, Mutex<AudioEngine>>,
    selection: Selection,
) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .set_loop_ms(Some(selection))
}

#[tauri::command]
pub fn audio_clear_loop(state: State<'_, Mutex<AudioEngine>>) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .set_loop_ms(None)
}

#[tauri::command]
pub fn audio_set_volume(state: State<'_, Mutex<AudioEngine>>, volume: f32) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .set_volume(volume)
}

#[tauri::command]
pub fn audio_snapshot(state: State<'_, Mutex<AudioEngine>>) -> Result<PlaybackSnapshot, AppError> {
    Ok(state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .snapshot())
}

#[tauri::command]
pub fn audio_close(state: State<'_, Mutex<AudioEngine>>) -> Result<(), AppError> {
    state
        .lock()
        .map_err(|_| AppError::Audio("Playback engine lock poisoned".to_owned()))?
        .close()
}
