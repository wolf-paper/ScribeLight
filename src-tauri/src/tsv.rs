use crate::{error::AppError, model::*};
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

/// Yamabiko's `WORKSHEET_COLUMNS`, in order.
const HEADER: [&str; 10] = [
    "start_seconds",
    "end_seconds",
    "event_type",
    "japanese",
    "intelligibility",
    "speaker",
    "overlap",
    "confidence",
    "acoustic_tags",
    "notes",
];
/// Older ScribeLight exports named column four `transcription`.
const LEGACY_TEXT_COLUMN: &str = "transcription";
const TEXT_COLUMN_INDEX: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAnnotation {
    pub start_ms: u64,
    pub end_ms: u64,
    pub event_type: EventType,
    pub transcription: String,
    pub intelligibility: Option<Intelligibility>,
    pub speaker: Option<String>,
    pub overlap: Option<Overlap>,
    pub confidence: Option<Confidence>,
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

/// Blank review labels (as in subtitle-seeded worksheet rows) import as unset.
fn parse_optional_enum<T: for<'de> Deserialize<'de>>(
    value: &str,
    field: &str,
) -> Result<Option<T>, AppError> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    parse_enum(value, field).map(Some)
}

fn optional_enum_text<T: Serialize>(value: &Option<T>) -> Result<String, AppError> {
    value.as_ref().map_or_else(|| Ok(String::new()), enum_text)
}

/// Yamabiko spells the top level `intelligible`; projects keep `highly_intelligible`.
/// Import needs no counterpart: the model's serde alias accepts both spellings.
fn intelligibility_text(value: Option<&Intelligibility>) -> &'static str {
    match value {
        None => "",
        Some(Intelligibility::HighlyIntelligible) => "intelligible",
        Some(Intelligibility::PartiallyIntelligible) => "partially_intelligible",
        Some(Intelligibility::Unintelligible) => "unintelligible",
        Some(Intelligibility::NotApplicable) => "not_applicable",
    }
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

/// Exactly three decimals, formatted from integer milliseconds.
fn ms_to_seconds(milliseconds: u64) -> String {
    format!("{}.{:03}", milliseconds / 1000, milliseconds % 1000)
}

/// Worksheet fields must stay on one physical row, so each line break becomes a space.
fn single_line(value: &str) -> String {
    value.replace("\r\n", " ").replace(['\r', '\n'], " ")
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
    if label.contains(['\t', '\r', '\n']) {
        return Err(AppError::Tsv(format!(
            "{field} label contains a tab or line break: {label}"
        )));
    }
    Ok(label)
}

fn append_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

/// Writes Yamabiko's annotation worksheet: the fixed header, `\n`-terminated rows,
/// UTF-8 without a BOM, and no quoting, so every field is written verbatim.
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

    let mut text = HEADER.join("\t");
    text.push('\n');

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
            None if annotation.event_type == EventType::Speech => String::new(),
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

        let fields = [
            ms_to_seconds(annotation.start_ms),
            ms_to_seconds(annotation.end_ms),
            enum_text(&annotation.event_type)?,
            single_line(&annotation.transcription),
            intelligibility_text(annotation.intelligibility.as_ref()).to_owned(),
            speaker,
            optional_enum_text(&annotation.overlap)?,
            optional_enum_text(&annotation.confidence)?,
            acoustic_tags.join(";"),
            single_line(&annotation.notes),
        ];
        text.push_str(&fields.join("\t"));
        text.push('\n');
    }

    Ok(text)
}

pub fn write_tsv_to_path(path: &Path, project: &Project) -> Result<(), AppError> {
    let text = export_tsv(project)?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(text.as_bytes())?;
    file.commit()?;
    Ok(())
}

fn header_error() -> AppError {
    AppError::Tsv(
        "Expected the ten Yamabiko worksheet columns, with japanese (or legacy transcription) in column four"
            .into(),
    )
}

fn is_worksheet_header(record: &csv::StringRecord) -> bool {
    record.len() == HEADER.len()
        && record
            .iter()
            .zip(HEADER)
            .enumerate()
            .all(|(index, (name, expected))| {
                name == expected || (index == TEXT_COLUMN_INDEX && name == LEGACY_TEXT_COLUMN)
            })
}

/// Tokenizes a worksheet the way Yamabiko's `parse_annotation_worksheet` does: an
/// optional UTF-8 BOM, tab-delimited rows, quoting disabled, text taken verbatim,
/// and rows whose fields are all blank skipped.
pub fn parse_tsv(text: &str) -> Result<ImportedTsv, AppError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // The csv reader skips blank lines, but the header must be the first physical row.
    if text.starts_with(['\r', '\n']) {
        return Err(header_error());
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .quoting(false)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut record = csv::StringRecord::new();
    let has_header = reader
        .read_record(&mut record)
        .map_err(|error| AppError::Tsv(error.to_string()))?;
    if !has_header || !is_worksheet_header(&record) {
        return Err(header_error());
    }

    let mut annotations = vec![];
    let mut speakers = vec![];
    let mut acoustic_tags = vec![];
    while reader
        .read_record(&mut record)
        .map_err(|error| AppError::Tsv(error.to_string()))?
    {
        // A spreadsheet may save trailing rows whose fields are all empty.
        if record.iter().all(|field| field.trim().is_empty()) {
            continue;
        }
        if record.len() != HEADER.len() {
            return Err(AppError::Tsv(
                "Each worksheet row must contain exactly ten columns".into(),
            ));
        }
        let mut fields = record.iter();
        let [start_seconds, end_seconds, event_type, transcription, intelligibility, speaker, overlap, confidence, tags, notes]: [&str; 10] =
            std::array::from_fn(|_| fields.next().unwrap_or_default());

        let start_ms = seconds_to_ms(start_seconds, "start_seconds")?;
        let end_ms = seconds_to_ms(end_seconds, "end_seconds")?;
        if end_ms <= start_ms {
            return Err(AppError::Tsv(
                "end_seconds must be later than start_seconds".into(),
            ));
        }

        let event_type: EventType = parse_enum(event_type, "event_type")?;
        let speaker = if speaker == "none" {
            if event_type != EventType::NonSpeech {
                return Err(AppError::Tsv(
                    "The reserved speaker none is only valid for non_speech annotations".into(),
                ));
            }
            None
        } else if speaker.trim().is_empty() {
            None
        } else {
            append_unique(&mut speakers, speaker.to_owned());
            Some(speaker.to_owned())
        };
        let row_tags = if tags.is_empty() {
            vec![]
        } else {
            tags.split(';').map(str::to_owned).collect::<Vec<_>>()
        };
        if row_tags.iter().any(|tag| tag.trim().is_empty()) {
            return Err(AppError::Tsv(
                "Acoustic tag labels must be non-empty and non-whitespace".into(),
            ));
        }
        for tag in &row_tags {
            append_unique(&mut acoustic_tags, tag.clone());
        }

        annotations.push(ImportedAnnotation {
            start_ms,
            end_ms,
            event_type,
            transcription: transcription.to_owned(),
            intelligibility: parse_optional_enum(intelligibility, "intelligibility")?,
            speaker,
            overlap: parse_optional_enum(overlap, "overlap")?,
            confidence: parse_optional_enum(confidence, "confidence")?,
            acoustic_tags: row_tags,
            notes: notes.to_owned(),
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

    const HEADER_LINE: &str = "start_seconds\tend_seconds\tevent_type\tjapanese\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n";
    const LEGACY_HEADER_LINE: &str = "start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n";

    #[test]
    fn exports_the_yamabiko_header_and_integer_millisecond_times() {
        let mut project = Project::fixture("a.wav");
        project.audio_identity.duration_ms = 3_000_000;
        project.annotations = vec![
            annotation("a1", 842, 2115, "1", Some("s1"), vec![]),
            annotation("a2", 5, 70, "2", Some("s1"), vec![]),
            annotation("a3", 2_999_000, 2_999_999, "3", Some("s1"), vec![]),
        ];

        let text = export_tsv(&project).unwrap();
        let times = text
            .lines()
            .skip(1)
            .map(|line| line.split('\t').take(2).collect::<Vec<_>>().join("-"))
            .collect::<Vec<_>>();

        assert!(text.starts_with(HEADER_LINE));
        assert_eq!(times, ["0.005-0.070", "0.842-2.115", "2999.000-2999.999"]);
    }

    #[test]
    fn exports_exact_unquoted_worksheet_rows() {
        let mut project = Project::fixture("a.wav");
        project.audio_identity.duration_ms = 3_000;
        project.acoustic_tags = vec![LabelDefinition {
            id: "tag1".into(),
            label: "breath".into(),
        }];
        let mut row = annotation("a1", 842, 2115, "1", Some("s1"), vec!["tag1"]);
        row.transcription = "\"もう一度\"\nお願いします".into();
        row.notes = "clipped to \"sh\"; breath".into();
        project.annotations = vec![row];

        let text = export_tsv(&project).unwrap();

        assert_eq!(
            text,
            format!(
                "{HEADER_LINE}0.842\t2.115\tspeech\t\"もう一度\" お願いします\tintelligible\tspeaker_1\tnone\thigh\tbreath\tclipped to \"sh\"; breath\n"
            )
        );
        let imported = parse_tsv(&text).unwrap();
        assert_eq!(
            imported.annotations[0].transcription,
            "\"もう一度\" お願いします"
        );
        assert_eq!(imported.annotations[0].notes, "clipped to \"sh\"; breath");
    }

    #[test]
    fn export_flattens_every_line_ending_to_one_space() {
        let mut project = Project::fixture("a.wav");
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        project.annotations[0].transcription = "first\r\nsecond\rthird\nfourth".into();
        project.annotations[0].notes = "note one\r\nnote two\n\nnote three".into();

        let text = export_tsv(&project).unwrap();
        let imported = parse_tsv(&text).unwrap();

        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains('\r'));
        assert_eq!(
            imported.annotations[0].transcription,
            "first second third fourth"
        );
        assert_eq!(
            imported.annotations[0].notes,
            "note one note two  note three"
        );
    }

    #[test]
    fn imports_japanese_as_transcription_and_discovers_labels() {
        let text = format!(
            "{HEADER_LINE}0.100\t0.250\tspeech\tこんにちは\tintelligible\tspeaker_7\tnone\thigh\tquiet_dialogue;breath\t\n"
        );

        let imported = parse_tsv(&text).unwrap();

        assert_eq!(imported.annotations[0].transcription, "こんにちは");
        assert_eq!(
            imported.annotations[0].intelligibility,
            Some(Intelligibility::HighlyIntelligible)
        );
        assert_eq!(imported.speakers, vec!["speaker_7"]);
        assert_eq!(imported.acoustic_tags, vec!["quiet_dialogue", "breath"]);
    }

    #[test]
    fn imports_verbatim_with_quoting_disabled_bom_stripped_and_blank_rows_skipped() {
        let text = format!(
            "\u{feff}{}{}{}{}{}{}",
            HEADER_LINE.replace('\n', "\r\n"),
            "0.100\t0.250\tspeech\t\"quoted start\tintelligible\tspeaker_1\tnone\thigh\t\tclipped to \"sh\"; breath\r\n",
            "\t\t\t\t\t\t\t\t\t\r\n",
            "0.300\t0.400\tspeech\tfirst\\nsecond \\\\ end\tpartially_intelligible\tspeaker_1\tnone\tmedium\t\t\"\"\r\n",
            " \t\t \r\n",
            "\t\t\n",
        );

        let imported = parse_tsv(&text).unwrap();

        assert_eq!(imported.annotations.len(), 2);
        assert_eq!(imported.annotations[0].transcription, "\"quoted start");
        assert_eq!(imported.annotations[0].notes, "clipped to \"sh\"; breath");
        assert_eq!(
            imported.annotations[1].transcription,
            "first\\nsecond \\\\ end"
        );
        assert_eq!(imported.annotations[1].notes, "\"\"");
    }

    #[test]
    fn legacy_transcription_header_and_highly_intelligible_reexport_as_yamabiko() {
        let text = format!(
            "{LEGACY_HEADER_LINE}0.100\t0.250\tspeech\tlegacy\thighly_intelligible\tspeaker_1\tnone\thigh\t\t\n"
        );
        let imported = parse_tsv(&text).unwrap();
        assert_eq!(imported.annotations[0].transcription, "legacy");
        assert_eq!(
            imported.annotations[0].intelligibility,
            Some(Intelligibility::HighlyIntelligible)
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

        assert_eq!(
            export_tsv(&project).unwrap(),
            format!(
                "{HEADER_LINE}0.100\t0.250\tspeech\tlegacy\tintelligible\tspeaker_1\tnone\thigh\t\t\n"
            )
        );
    }

    #[test]
    fn blank_review_labels_import_as_unset_and_export_blank() {
        let text = format!("{HEADER_LINE}0.100\t0.250\tspeech\t~♪\t\t\t\t\t\t\n");
        let imported = parse_tsv(&text).unwrap();
        let row = &imported.annotations[0];
        assert_eq!(row.intelligibility, None);
        assert_eq!(row.speaker, None);
        assert_eq!(row.overlap, None);
        assert_eq!(row.confidence, None);
        assert!(imported.speakers.is_empty());

        let mut project = Project::fixture("a.wav");
        let mut unreviewed = annotation("a1", 100, 250, "1", Some("s1"), vec![]);
        unreviewed.transcription = "~♪".into();
        unreviewed.intelligibility = None;
        unreviewed.speaker_id = None;
        unreviewed.overlap = None;
        unreviewed.confidence = None;
        project.annotations = vec![unreviewed];

        let exported = export_tsv(&project).unwrap();
        assert_eq!(
            exported.lines().nth(1),
            Some("0.100\t0.250\tspeech\t~♪\t\t\t\t\t\t")
        );
        assert_eq!(
            parse_tsv(&exported).unwrap().annotations,
            imported.annotations
        );
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
    fn rejects_incompatible_headers_rows_boundaries_tabs_and_controlled_values() {
        let row = "0.100\t0.200\tspeech\tword\tintelligible\tspeaker_1\tnone\thigh\t\t\n";
        for text in [
            "start_seconds\tend_seconds\tevent_type\tjapanese\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\n".to_owned(),
            HEADER_LINE.replace("japanese", "text") + row,
            HEADER_LINE.replace("notes", "\"notes\"") + row,
            format!("\n{HEADER_LINE}{row}"),
            format!("{HEADER_LINE}0.100\t0.200\tspeech\n"),
            format!("{HEADER_LINE}{}", row.replace('\n', "\textra\n")),
            format!("{HEADER_LINE}0.200\t0.100\tspeech\tword\tintelligible\tspeaker_1\tnone\thigh\t\t\n"),
            format!("{HEADER_LINE}0.100\t0.200\tunknown\tword\tintelligible\tspeaker_1\tnone\thigh\t\t\n"),
            format!("{HEADER_LINE}0.100\t0.200\tspeech\tword\tclear\tspeaker_1\tnone\thigh\t\t\n"),
            String::new(),
        ] {
            assert!(parse_tsv(&text).is_err(), "{text:?}");
        }

        let mut project = Project::fixture("a.wav");
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        project.annotations[0].notes = "not\ta portable field".into();
        assert!(export_tsv(&project).is_err());
    }

    #[test]
    fn rejects_blank_and_multiline_speaker_and_acoustic_tag_labels_on_export() {
        let mut project = Project::fixture("a.wav");
        project.annotations = vec![annotation("a1", 100, 200, "1", Some("s1"), vec![])];
        for label in ["", "  ", "speaker\n1"] {
            project.speakers[0].label = label.into();
            assert!(export_tsv(&project).is_err(), "{label:?}");
        }

        project.speakers[0].label = "speaker_1".into();
        project.annotations[0].acoustic_tag_ids = vec!["tag1".into()];
        for label in ["", "  ", "tag\tname", "tag;name", "tag\r\nname"] {
            project.acoustic_tags = vec![LabelDefinition {
                id: "tag1".into(),
                label: label.into(),
            }];
            assert!(export_tsv(&project).is_err(), "{label:?}");
        }
    }

    #[test]
    fn rejects_blank_imported_acoustic_tag_segments() {
        for tags in ["  ", ";tag_a", "tag_a;", "tag_a;;tag_b"] {
            let text = format!(
                "{HEADER_LINE}0.100\t0.200\tspeech\tword\tintelligible\tspeaker_1\tnone\thigh\t{tags}\t\n"
            );
            assert!(parse_tsv(&text).is_err(), "{text}");
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
            intelligibility: Some(Intelligibility::HighlyIntelligible),
            speaker_id: speaker_id.map(str::to_owned),
            overlap: Some(Overlap::None),
            confidence: Some(Confidence::High),
            acoustic_tag_ids: acoustic_tag_ids.into_iter().map(str::to_owned).collect(),
            notes: String::new(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }
}
