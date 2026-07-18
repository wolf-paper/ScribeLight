use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("File operation failed: {0}")]
    Io(String),
    #[error("Project data is invalid: {0}")]
    InvalidProject(String),
    #[error("Audio operation failed: {0}")]
    Audio(String),
    #[error("TSV operation failed: {0}")]
    Tsv(String),
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
