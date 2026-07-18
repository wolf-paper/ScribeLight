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
    validate_schema_version(project)?;
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
    let project = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::InvalidProject(error.to_string()))?;
    validate_schema_version(&project)?;
    Ok(project)
}

fn validate_schema_version(project: &Project) -> Result<(), AppError> {
    if project.schema_version != 1 {
        return Err(AppError::InvalidProject(format!(
            "unsupported schema version {}; expected 1",
            project.schema_version
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{error::AppError, model::*};
    use serde_json::json;

    const GOLDEN_PROJECT_JSON: &str = r#"
{
  "schemaVersion": 1,
  "audioIdentity": {
    "canonicalPath": "C:/clips/golden.wav",
    "size": 42,
    "modifiedMs": 1700000000000,
    "durationMs": 12345,
    "sampleRate": 48000,
    "channels": 2
  },
  "displayFormat": "seconds",
  "speakers": [{ "id": "s1", "label": "Speaker one" }],
  "acousticTags": [{ "id": "tag1", "label": "noise" }],
  "annotations": [{
    "id": "a1",
    "startMs": 100,
    "endMs": 200,
    "eventType": "non_speech",
    "transcription": "[noise]",
    "intelligibility": "partially_intelligible",
    "speakerId": null,
    "overlap": "overlap",
    "confidence": "medium",
    "acousticTagIds": ["tag1"],
    "notes": "literal golden annotation",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:01.000Z"
  }],
  "draft": {
    "startMs": 201,
    "endMs": 300,
    "eventType": "speech",
    "transcription": "draft",
    "intelligibility": "unintelligible",
    "speakerId": "s1",
    "overlap": "none",
    "confidence": "low",
    "acousticTagIds": [],
    "notes": "literal golden draft"
  },
  "activeAnnotationId": "a1",
  "activeSelection": { "startMs": 100, "endMs": 200 },
  "exportSettings": { "multilinePolicy": "quoted" }
}
"#;

    const GOLDEN_NULLABLE_PROJECT_JSON: &str = r#"
{
  "schemaVersion": 1,
  "audioIdentity": {
    "canonicalPath": "C:/clips/nullable.wav",
    "size": 84,
    "modifiedMs": 1700000000001,
    "durationMs": 67890,
    "sampleRate": 44100,
    "channels": 1
  },
  "displayFormat": "clock",
  "speakers": [],
  "acousticTags": [],
  "annotations": [{
    "id": "a2",
    "startMs": 0,
    "endMs": 1,
    "eventType": "speech",
    "transcription": "hello",
    "intelligibility": "intelligible",
    "speakerId": "s2",
    "overlap": "none",
    "confidence": "high",
    "acousticTagIds": [],
    "notes": "",
    "createdAt": "2026-01-02T00:00:00.000Z",
    "updatedAt": "2026-01-02T00:00:00.000Z"
  }],
  "draft": {
    "startMs": 2,
    "endMs": 3,
    "eventType": "non_speech",
    "transcription": "",
    "intelligibility": "not_applicable",
    "speakerId": null,
    "overlap": "overlap",
    "confidence": "medium",
    "acousticTagIds": [],
    "notes": ""
  },
  "activeAnnotationId": null,
  "activeSelection": null,
  "exportSettings": { "multilinePolicy": "escape" }
}
"#;

    fn project() -> Project {
        Project::fixture("C:/clips/a.wav")
    }

    #[test]
    fn golden_project_json_round_trips_the_camel_case_wire_contract() {
        let project: Project = serde_json::from_str(GOLDEN_PROJECT_JSON).unwrap();

        assert_eq!(project.schema_version, 1);
        assert_eq!(project.audio_identity.canonical_path, "C:/clips/golden.wav");
        assert_eq!(project.annotations[0].speaker_id, None);
        assert_eq!(project.active_annotation_id.as_deref(), Some("a1"));
        assert_eq!(project.active_selection.as_ref().unwrap().start_ms, 100);
        assert_eq!(
            serde_json::to_value(&project).unwrap(),
            serde_json::from_str::<serde_json::Value>(GOLDEN_PROJECT_JSON).unwrap()
        );
    }

    #[test]
    fn golden_nullable_project_json_preserves_null_wire_fields() {
        let project: Project = serde_json::from_str(GOLDEN_NULLABLE_PROJECT_JSON).unwrap();

        assert_eq!(project.annotations[0].speaker_id.as_deref(), Some("s2"));
        assert_eq!(project.draft.speaker_id, None);
        assert_eq!(project.active_annotation_id, None);
        assert_eq!(project.active_selection, None);
        assert_eq!(
            serde_json::to_value(&project).unwrap(),
            serde_json::from_str::<serde_json::Value>(GOLDEN_NULLABLE_PROJECT_JSON).unwrap()
        );
    }

    #[test]
    fn enum_wire_values_cover_the_typescript_contract() {
        assert_eq!(
            serde_json::from_str::<EventType>(r#""speech""#).unwrap(),
            EventType::Speech
        );
        assert_eq!(
            serde_json::from_str::<EventType>(r#""non_speech""#).unwrap(),
            EventType::NonSpeech
        );
        assert_eq!(
            serde_json::from_str::<Intelligibility>(r#""intelligible""#).unwrap(),
            Intelligibility::Intelligible
        );
        assert_eq!(
            serde_json::from_str::<Intelligibility>(r#""partially_intelligible""#).unwrap(),
            Intelligibility::PartiallyIntelligible
        );
        assert_eq!(
            serde_json::from_str::<Intelligibility>(r#""unintelligible""#).unwrap(),
            Intelligibility::Unintelligible
        );
        assert_eq!(
            serde_json::from_str::<Intelligibility>(r#""not_applicable""#).unwrap(),
            Intelligibility::NotApplicable
        );
        assert_eq!(
            serde_json::from_str::<Overlap>(r#""none""#).unwrap(),
            Overlap::None
        );
        assert_eq!(
            serde_json::from_str::<Overlap>(r#""overlap""#).unwrap(),
            Overlap::Overlap
        );
        assert_eq!(
            serde_json::from_str::<Confidence>(r#""high""#).unwrap(),
            Confidence::High
        );
        assert_eq!(
            serde_json::from_str::<Confidence>(r#""medium""#).unwrap(),
            Confidence::Medium
        );
        assert_eq!(
            serde_json::from_str::<Confidence>(r#""low""#).unwrap(),
            Confidence::Low
        );
        assert_eq!(
            serde_json::from_str::<TimeDisplayFormat>(r#""seconds""#).unwrap(),
            TimeDisplayFormat::Seconds
        );
        assert_eq!(
            serde_json::from_str::<TimeDisplayFormat>(r#""clock""#).unwrap(),
            TimeDisplayFormat::Clock
        );
        assert_eq!(
            serde_json::from_str::<MultilinePolicy>(r#""escape""#).unwrap(),
            MultilinePolicy::Escape
        );
        assert_eq!(
            serde_json::from_str::<MultilinePolicy>(r#""space""#).unwrap(),
            MultilinePolicy::Space
        );
        assert_eq!(
            serde_json::from_str::<MultilinePolicy>(r#""quoted""#).unwrap(),
            MultilinePolicy::Quoted
        );
    }

    #[test]
    fn project_path_is_deterministic_and_stays_under_app_data() {
        let dir = tempfile::tempdir().unwrap();
        let first = project_path(dir.path(), "C:/clips/a.wav");
        let same = project_path(dir.path(), "C:/clips/a.wav");
        let different = project_path(dir.path(), "C:/clips/b.wav");

        assert!(first.starts_with(dir.path()));
        assert_eq!(first, same);
        assert_ne!(first, different);
        assert_eq!(first.parent().unwrap().file_name().unwrap(), "projects");
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

    #[test]
    fn rejects_unsupported_schema_versions_before_rewriting_projects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.json");
        std::fs::write(&path, b"existing project bytes").unwrap();
        let mut unsupported = project();
        unsupported.schema_version = 2;

        let error = save_project_to(&path, &unsupported).unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({
                "kind": "invalid_project",
                "message": "unsupported schema version 2; expected 1"
            })
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"existing project bytes");

        let unsupported_json =
            GOLDEN_PROJECT_JSON.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        std::fs::write(&path, unsupported_json).unwrap();
        let error = load_project_from(&path).unwrap_err();
        assert!(matches!(
            error,
            AppError::InvalidProject(message)
                if message == "unsupported schema version 2; expected 1"
        ));
    }

    #[test]
    fn maps_malformed_json_to_a_serializable_invalid_project_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.json");
        std::fs::write(&path, b"{ malformed json").unwrap();

        let error = load_project_from(&path).unwrap_err();
        match error {
            AppError::InvalidProject(message) => {
                assert!(!message.is_empty());
                assert_eq!(
                    serde_json::to_value(AppError::InvalidProject(message.clone())).unwrap(),
                    json!({ "kind": "invalid_project", "message": message })
                );
            }
            other => panic!("expected invalid project error, received {other:?}"),
        }
    }
}
