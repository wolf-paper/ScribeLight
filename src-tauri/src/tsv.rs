use crate::{error::AppError, model::*};
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

const HEADER: [&str; 10] = [
    "start_seconds",
    "end_seconds",
    "event_type",
    "transcription",
    "intelligibility",
    "speaker",
    "overlap",
    "confidence",
    "acoustic_tags",
    "notes",
];

#[derive(Debug, Serialize, Deserialize)]
struct TsvRow {
    start_seconds: String,
    end_seconds: String,
    event_type: String,
    #[serde(alias = "japanese")]
    transcription: String,
    intelligibility: String,
    speaker: String,
    overlap: String,
    confidence: String,
    acoustic_tags: String,
    notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAnnotation {
    pub start_ms: u64,
    pub end_ms: u64,
    pub event_type: EventType,
    pub transcription: String,
    pub intelligibility: Intelligibility,
    pub speaker: Option<String>,
    pub overlap: Overlap,
    pub confidence: Confidence,
    pub acoustic_tags: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTsv {
    pub annotations: Vec<ImportedAnnotation>,
    pub speakers: Vec<String>,
    pub acoustic_tags: Vec<String>,
}

pub fn encode_multiline(value: &str, policy: MultilinePolicy) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    match policy {
        MultilinePolicy::Escape => normalized.replace('\\', "\\\\").replace('\n', "\\n"),
        MultilinePolicy::Space => normalized.replace('\n', " "),
        MultilinePolicy::Quoted => normalized,
    }
}

pub fn decode_multiline(value: &str, policy: MultilinePolicy) -> String {
    if policy != MultilinePolicy::Escape {
        return value.to_owned();
    }

    let mut decoded = String::new();
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            decoded.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => decoded.push('\n'),
            Some('\\') => decoded.push('\\'),
            Some(other) => {
                decoded.push('\\');
                decoded.push(other);
            }
            None => decoded.push('\\'),
        }
    }
    decoded
}

fn enum_text<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_value(value)
        .map_err(|error| AppError::Tsv(error.to_string()))?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::Tsv("Expected string enum".into()))
}

fn parse_enum<T: for<'de> Deserialize<'de>>(value: &str, field: &str) -> Result<T, AppError> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|_| AppError::Tsv(format!("Unsupported {field} value: {value}")))
}

fn seconds_to_ms(value: &str, field: &str) -> Result<u64, AppError> {
    let seconds: f64 = value
        .parse()
        .map_err(|_| AppError::Tsv(format!("Invalid {field}: {value}")))?;
    let milliseconds = seconds * 1000.0;
    if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
        return Err(AppError::Tsv(format!("Invalid {field}: {value}")));
    }
    Ok(milliseconds.round() as u64)
}

fn label_for_id(
    definitions: &[LabelDefinition],
    id: &str,
    field: &str,
) -> Result<String, AppError> {
    let label = definitions
        .iter()
        .find(|definition| definition.id == id)
        .map(|definition| definition.label.clone())
        .ok_or_else(|| AppError::Tsv(format!("Unknown {field} id: {id}")))?;
    if label.trim().is_empty() {
        return Err(AppError::Tsv(format!(
            "{field} label must not be empty or whitespace-only"
        )));
    }
    if label.contains('\t') {
        return Err(AppError::Tsv(format!(
            "{field} label contains a tab: {label}"
        )));
    }
    Ok(label)
}

fn append_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

pub fn export_tsv(project: &Project) -> Result<String, AppError> {
    crate::persistence::validate_schema_version(project)?;

    let mut annotations = project.annotations.clone();
    annotations.sort_by_key(|annotation| {
        (
            annotation.start_ms,
            annotation.end_ms,
            annotation.created_at.clone(),
        )
    });

    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .delimiter(b'\t')
        .terminator(csv::Terminator::Any(b'\n'))
        .from_writer(vec![]);
    writer
        .write_record(HEADER)
        .map_err(|error| AppError::Tsv(error.to_string()))?;

    for annotation in annotations {
        if annotation.end_ms <= annotation.start_ms
            || annotation.end_ms > project.audio_identity.duration_ms
        {
            return Err(AppError::Tsv(format!(
                "Annotation {} has invalid boundaries",
                annotation.id
            )));
        }
        if annotation.transcription.contains('\t') || annotation.notes.contains('\t') {
            return Err(AppError::Tsv(format!(
                "Annotation {} contains a tab in a text field",
                annotation.id
            )));
        }

        let speaker = match annotation.speaker_id.as_deref() {
            Some(id) => {
                let label = label_for_id(&project.speakers, id, "speaker")?;
                if label == "none" {
                    return Err(AppError::Tsv(
                        "Speaker label none is reserved for a null speaker".into(),
                    ));
                }
                label
            }
            None => "none".into(),
        };

        let mut acoustic_tags = Vec::with_capacity(annotation.acoustic_tag_ids.len());
        for tag_id in &annotation.acoustic_tag_ids {
            let label = label_for_id(&project.acoustic_tags, tag_id, "acoustic tag")?;
            if label.contains(';') {
                return Err(AppError::Tsv(format!(
                    "Acoustic tag label contains a semicolon: {label}"
                )));
            }
            acoustic_tags.push(label);
        }

        writer
            .serialize(TsvRow {
                start_seconds: format!("{:.3}", annotation.start_ms as f64 / 1000.0),
                end_seconds: format!("{:.3}", annotation.end_ms as f64 / 1000.0),
                event_type: enum_text(&annotation.event_type)?,
                transcription: encode_multiline(
                    &annotation.transcription,
                    project.export_settings.multiline_policy.clone(),
                ),
                intelligibility: enum_text(&annotation.intelligibility)?,
                speaker,
                overlap: enum_text(&annotation.overlap)?,
                confidence: enum_text(&annotation.confidence)?,
                acoustic_tags: acoustic_tags.join(";"),
                notes: encode_multiline(
                    &annotation.notes,
                    project.export_settings.multiline_policy.clone(),
                ),
            })
            .map_err(|error| AppError::Tsv(error.to_string()))?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|error| AppError::Tsv(error.to_string()))?;
    String::from_utf8(bytes).map_err(|error| AppError::Tsv(error.to_string()))
}

pub fn write_tsv_to_path(path: &Path, project: &Project) -> Result<(), AppError> {
    let text = export_tsv(project)?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(text.as_bytes())?;
    file.commit()?;
    Ok(())
}

pub fn parse_tsv(text: &str, multiline_policy: MultilinePolicy) -> Result<ImportedTsv, AppError> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .flexible(false)
        .from_reader(text.as_bytes());
    let headers = reader
        .headers()
        .map_err(|error| AppError::Tsv(error.to_string()))?
        .clone();
    let valid_headers = headers.len() == HEADER.len()
        && headers
            .iter()
            .enumerate()
            .all(|(index, name)| name == HEADER[index] || (index == 3 && name == "japanese"));
    if !valid_headers {
        return Err(AppError::Tsv(
            "Expected the ten portable columns, with transcription or japanese in column four"
                .into(),
        ));
    }

    let mut annotations = vec![];
    let mut speakers = vec![];
    let mut acoustic_tags = vec![];
    for row in reader.deserialize::<TsvRow>() {
        let row = row.map_err(|error| AppError::Tsv(error.to_string()))?;
        let start_ms = seconds_to_ms(&row.start_seconds, "start_seconds")?;
        let end_ms = seconds_to_ms(&row.end_seconds, "end_seconds")?;
        if end_ms <= start_ms {
            return Err(AppError::Tsv(
                "end_seconds must be later than start_seconds".into(),
            ));
        }
        if row.transcription.contains('\t') || row.notes.contains('\t') {
            return Err(AppError::Tsv("Text fields cannot contain tabs".into()));
        }

        let event_type: EventType = parse_enum(&row.event_type, "event_type")?;
        let speaker = if row.speaker == "none" {
            if event_type != EventType::NonSpeech {
                return Err(AppError::Tsv(
                    "The reserved speaker none is only valid for non_speech annotations".into(),
                ));
            }
            None
        } else {
            if row.speaker.trim().is_empty() || row.speaker.contains('\t') {
                return Err(AppError::Tsv(
                    "Speaker labels must be non-empty and tab-free".into(),
                ));
            }
            append_unique(&mut speakers, row.speaker.clone());
            Some(row.speaker)
        };
        let row_tags = if row.acoustic_tags.is_empty() {
            vec![]
        } else {
            row.acoustic_tags
                .split(';')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        if row_tags
            .iter()
            .any(|tag| tag.trim().is_empty() || tag.contains('\t'))
        {
            return Err(AppError::Tsv(
                "Acoustic tag labels must be non-empty, non-whitespace, and tab-free".into(),
            ));
        }
        for tag in &row_tags {
            append_unique(&mut acoustic_tags, tag.clone());
        }

        annotations.push(ImportedAnnotation {
            start_ms,
            end_ms,
            event_type,
            transcription: decode_multiline(&row.transcription, multiline_policy.clone()),
            intelligibility: parse_enum(&row.intelligibility, "intelligibility")?,
            speaker,
            overlap: parse_enum(&row.overlap, "overlap")?,
            confidence: parse_enum(&row.confidence, "confidence")?,
            acoustic_tags: row_tags,
            notes: decode_multiline(&row.notes, multiline_policy.clone()),
        });
    }

    Ok(ImportedTsv {
        annotations,
        speakers,
        acoustic_tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_the_portable_header_and_three_decimal_times() {
        let mut project = Project::fixture("a.wav");
        project.audio_identity.duration_ms = 3_000;
        project.annotations.push(Annotation {
            id: "a1".into(),
            start_ms: 842,
            end_ms: 2115,
            event_type: EventType::Speech,
            transcription: "こんにちは".into(),
            intelligibility: Intelligibility::HighlyIntelligible,
            speaker_id: Some("s1".into()),
            overlap: Overlap::None,
            confidence: Confidence::High,
            acoustic_tag_ids: vec![],
            notes: String::new(),
            created_at: "1".into(),
            updated_at: "1".into(),
        });

        let text = export_tsv(&project).unwrap();

        assert!(text.starts_with(
            "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n"
        ));
        assert!(text.contains("0.842\t2.115\tspeech\tこんにちは"));
    }

    #[test]
    fn imports_japanese_as_transcription_and_discovers_labels() {
        let text = "start_seconds\tend_seconds\tevent_type\tjapanese\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.100\t0.250\tspeech\tこんにちは\tintelligible\tspeaker_7\tnone\thigh\tquiet_dialogue;breath\t\n";

        let imported = parse_tsv(text, MultilinePolicy::Escape).unwrap();

        assert_eq!(imported.annotations[0].transcription, "こんにちは");
        assert_eq!(imported.speakers, vec!["speaker_7"]);
        assert_eq!(imported.acoustic_tags, vec!["quiet_dialogue", "breath"]);
    }

    #[test]
    fn legacy_intelligibility_tsv_import_reexports_canonically() {
        let text = "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.100\t0.250\tspeech\tlegacy\tintelligible\tspeaker_1\tnone\thigh\t\t\n";
        let imported = parse_tsv(text, MultilinePolicy::Escape).unwrap();
        assert_eq!(
            imported.annotations[0].intelligibility,
            Intelligibility::HighlyIntelligible
        );

        let mut project = Project::fixture("a.wav");
        project.annotations = vec![Annotation {
            id: "legacy".into(),
            start_ms: imported.annotations[0].start_ms,
            end_ms: imported.annotations[0].end_ms,
            event_type: imported.annotations[0].event_type.clone(),
            transcription: imported.annotations[0].transcription.clone(),
            intelligibility: imported.annotations[0].intelligibility.clone(),
            speaker_id: Some("s1".into()),
            overlap: imported.annotations[0].overlap.clone(),
            confidence: imported.annotations[0].confidence.clone(),
            acoustic_tag_ids: vec![],
            notes: imported.annotations[0].notes.clone(),
            created_at: "1".into(),
            updated_at: "1".into(),
        }];

        let exported = export_tsv(&project).unwrap();
        assert!(exported.contains("\thighly_intelligible\t"));
        assert!(!exported.contains("\tintelligible\t"));
    }

    #[test]
    fn escape_policy_round_trips_backslashes_and_newlines() {
        let source = "first\\path\nsecond";
        let encoded = encode_multiline(source, MultilinePolicy::Escape);

        assert_eq!(decode_multiline(&encoded, MultilinePolicy::Escape), source);
    }

    #[test]
    fn space_policy_normalizes_every_line_ending_through_export_and_parse() {
        let mut project = Project::fixture("a.wav");
        project.export_settings.multiline_policy = MultilinePolicy::Space;
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        project.annotations[0].transcription = "first\r\nsecond\rthird\nfourth".into();
        project.annotations[0].notes = "note one\r\nnote two".into();

        let text = export_tsv(&project).unwrap();
        let imported = parse_tsv(&text, MultilinePolicy::Space).unwrap();

        assert!(!text.contains('\r'));
        assert!(text.contains("first second third fourth"));
        assert_eq!(
            imported.annotations[0].transcription,
            "first second third fourth"
        );
        assert_eq!(imported.annotations[0].notes, "note one note two");
    }

    #[test]
    fn exports_current_labels_in_chronological_order_and_uses_reserved_none() {
        let mut project = Project::fixture("a.wav");
        project.audio_identity.duration_ms = 3_000;
        project.speakers[0].label = "renamed speaker".into();
        project.acoustic_tags = vec![LabelDefinition {
            id: "tag1".into(),
            label: "renamed tag".into(),
        }];
        project.annotations = vec![
            annotation("later", 500, 600, "2", None, vec![]),
            annotation("early", 100, 200, "1", Some("s1"), vec!["tag1"]),
        ];

        let text = export_tsv(&project).unwrap();
        let lines: Vec<_> = text.lines().collect();

        assert!(lines[1].contains("renamed speaker\tnone\thigh\trenamed tag"));
        assert!(lines[2].contains("\tnone\tnone\thigh\t"));
    }

    #[test]
    fn quoted_policy_preserves_physical_multiline_fields() {
        let mut project = Project::fixture("a.wav");
        project.audio_identity.duration_ms = 1_000;
        project.export_settings.multiline_policy = MultilinePolicy::Quoted;
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        project.annotations[0].transcription = "first\nsecond".into();

        let text = export_tsv(&project).unwrap();
        let imported = parse_tsv(&text, MultilinePolicy::Quoted).unwrap();

        assert!(text.contains("\"first\nsecond\""));
        assert_eq!(imported.annotations[0].transcription, "first\nsecond");
    }

    #[test]
    fn rejects_incompatible_headers_boundaries_tabs_and_controlled_values() {
        for text in [
            "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\n",
            "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.200\t0.100\tspeech\tword\tintelligible\ts1\tnone\thigh\t\t\n",
            "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.100\t0.200\tunknown\tword\tintelligible\ts1\tnone\thigh\t\t\n",
        ] {
            assert!(parse_tsv(text, MultilinePolicy::Escape).is_err(), "{text}");
        }

        let mut project = Project::fixture("a.wav");
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        project.annotations[0].notes = "not\ta portable field".into();
        assert!(export_tsv(&project).is_err());
    }

    #[test]
    fn rejects_blank_speaker_and_acoustic_tag_labels_on_export() {
        let mut project = Project::fixture("a.wav");
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        for label in ["", "  "] {
            project.speakers[0].label = label.into();
            assert!(export_tsv(&project).is_err(), "{label:?}");
        }

        project.speakers[0].label = "speaker_1".into();
        project.annotations[0].acoustic_tag_ids = vec!["tag1".into()];
        for label in ["", "  ", "tag\tname", "tag;name"] {
            project.acoustic_tags = vec![LabelDefinition {
                id: "tag1".into(),
                label: label.into(),
            }];
            assert!(export_tsv(&project).is_err(), "{label:?}");
        }
    }

    #[test]
    fn rejects_blank_imported_labels_and_empty_acoustic_tag_segments() {
        for (speaker, tags) in [
            ("  ", ""),
            ("speaker_1", "  "),
            ("speaker_1", ";tag_a"),
            ("speaker_1", "tag_a;"),
            ("speaker_1", "tag_a;;tag_b"),
        ] {
            let text = format!(
                "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.100\t0.200\tspeech\tword\tintelligible\t{speaker}\tnone\thigh\t{tags}\t\n"
            );
            assert!(parse_tsv(&text, MultilinePolicy::Escape).is_err(), "{text}");
        }
    }

    fn annotation(
        id: &str,
        start_ms: u64,
        end_ms: u64,
        created_at: &str,
        speaker_id: Option<&str>,
        acoustic_tag_ids: Vec<&str>,
    ) -> Annotation {
        Annotation {
            id: id.into(),
            start_ms,
            end_ms,
            event_type: if speaker_id.is_some() {
                EventType::Speech
            } else {
                EventType::NonSpeech
            },
            transcription: String::new(),
            intelligibility: Intelligibility::HighlyIntelligible,
            speaker_id: speaker_id.map(str::to_owned),
            overlap: Overlap::None,
            confidence: Confidence::High,
            acoustic_tag_ids: acoustic_tag_ids.into_iter().map(str::to_owned).collect(),
            notes: String::new(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }
}
