use crate::{error::AppError, model::Project};
use atomic_write_file::AtomicWriteFile;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub fn project_path(app_data_dir: &Path, canonical_audio_path: &str) -> PathBuf {
    let hash = blake3::hash(canonical_audio_path.as_bytes()).to_hex();
    app_data_dir.join("projects").join(format!("{hash}.json"))
}

pub fn save_project_to(path: &Path, project: &Project) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(project)
        .map_err(|error| AppError::InvalidProject(error.to_string()))?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(&bytes)?;
    file.commit()?;
    Ok(())
}

pub fn load_project_from(path: &Path) -> Result<Project, AppError> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| AppError::InvalidProject(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn project() -> Project {
        Project::fixture("C:/clips/a.wav")
    }

    #[test]
    fn saves_and_replaces_a_project_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.json");
        let mut value = project();
        save_project_to(&path, &value).unwrap();
        value.display_format = TimeDisplayFormat::Clock;
        save_project_to(&path, &value).unwrap();
        assert_eq!(
            load_project_from(&path).unwrap().display_format,
            TimeDisplayFormat::Clock
        );
    }
}
