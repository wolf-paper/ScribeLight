use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioIdentity {
    pub canonical_path: String,
    pub size: u64,
    pub modified_ms: i64,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeakData {
    pub total_frames: u64,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub frames_per_peak: u32,
    pub channels: Vec<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub processed_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Selection {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    Empty,
    Paused,
    Playing,
    Error(String),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub state: PlaybackState,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub loop_range: Option<Selection>,
    pub volume: f32,
    pub underruns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabelDefinition {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Speech,
    NonSpeech,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Intelligibility {
    #[serde(alias = "intelligible")]
    HighlyIntelligible,
    PartiallyIntelligible,
    Unintelligible,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Overlap {
    None,
    Overlap,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TimeDisplayFormat {
    Seconds,
    Clock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MultilinePolicy {
    Escape,
    Space,
    Quoted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub event_type: EventType,
    pub transcription: String,
    pub intelligibility: Intelligibility,
    pub speaker_id: Option<String>,
    pub overlap: Overlap,
    pub confidence: Confidence,
    pub acoustic_tag_ids: Vec<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDraft {
    pub start_ms: u64,
    pub end_ms: u64,
    pub event_type: EventType,
    pub transcription: String,
    pub intelligibility: Intelligibility,
    pub speaker_id: Option<String>,
    pub overlap: Overlap,
    pub confidence: Confidence,
    pub acoustic_tag_ids: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub multiline_policy: MultilinePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub audio_identity: AudioIdentity,
    pub display_format: TimeDisplayFormat,
    pub speakers: Vec<LabelDefinition>,
    pub acoustic_tags: Vec<LabelDefinition>,
    pub annotations: Vec<Annotation>,
    pub draft: AnnotationDraft,
    pub active_annotation_id: Option<String>,
    pub active_selection: Option<Selection>,
    pub export_settings: ExportSettings,
}

#[cfg(test)]
impl Project {
    pub fn fixture(path: &str) -> Self {
        Self {
            schema_version: 1,
            audio_identity: AudioIdentity {
                canonical_path: path.into(),
                size: 1,
                modified_ms: 1,
                duration_ms: 1000,
                sample_rate: 48000,
                channels: 1,
            },
            display_format: TimeDisplayFormat::Seconds,
            speakers: vec![LabelDefinition {
                id: "s1".into(),
                label: "speaker_1".into(),
            }],
            acoustic_tags: vec![],
            annotations: vec![],
            draft: AnnotationDraft {
                start_ms: 0,
                end_ms: 0,
                event_type: EventType::Speech,
                transcription: String::new(),
                intelligibility: Intelligibility::HighlyIntelligible,
                speaker_id: Some("s1".into()),
                overlap: Overlap::None,
                confidence: Confidence::High,
                acoustic_tag_ids: vec![],
                notes: String::new(),
            },
            active_annotation_id: None,
            active_selection: None,
            export_settings: ExportSettings {
                multiline_policy: MultilinePolicy::Escape,
            },
        }
    }
}
