import type { ImportedAnnotation, ImportedTsv } from '../bridge/native';
import type { Annotation, AnnotationDraft, LabelDefinition, Project } from './types';
import { normalizeDraftForEventType, validateDraft } from './validation';

const eventTypes = ['speech', 'non_speech'] as const;
const intelligibilities = ['intelligible', 'partially_intelligible', 'unintelligible', 'not_applicable'] as const;
const overlaps = ['none', 'overlap'] as const;
const confidences = ['high', 'medium', 'low'] as const;

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) throw new Error(`Imported ${field} is invalid`);
}

function cleanLabel(raw: string): string | null {
  const label = raw.trim();
  return !label || label === 'none' ? null : label;
}

function uniqueLabels(values: string[]): string[] {
  const result: string[] = [];
  for (const raw of values) {
    const label = cleanLabel(raw);
    if (label && !result.includes(label)) result.push(label);
  }
  return result;
}

function validatePortableRow(row: ImportedAnnotation): void {
  assertEnum(row.eventType, eventTypes, 'event type');
  assertEnum(row.intelligibility, intelligibilities, 'intelligibility');
  assertEnum(row.overlap, overlaps, 'overlap');
  assertEnum(row.confidence, confidences, 'confidence');
  if (!Number.isInteger(row.startMs) || row.startMs < 0) throw new Error('Imported Start must be a non-negative integer millisecond value');
  if (!Number.isInteger(row.endMs) || row.endMs <= row.startMs) throw new Error('Imported End must be later than Start');
  if (row.eventType === 'speech' && !cleanLabel(row.speaker ?? '')) throw new Error('Imported speech annotations require a speaker');
  if (row.eventType === 'speech' && row.intelligibility === 'not_applicable') {
    throw new Error('Imported speech intelligibility cannot be not_applicable');
  }
}

export function mergeImportedTsv(
  project: Project,
  imported: ImportedTsv,
  id: () => string = () => crypto.randomUUID(),
  now = new Date().toISOString()
): Project {
  for (const row of imported.annotations) validatePortableRow(row);

  const speakerLabels = uniqueLabels([
    ...imported.speakers,
    ...imported.annotations.flatMap((row) => row.speaker ? [row.speaker] : [])
  ]);
  const tagLabels = uniqueLabels([
    ...imported.acousticTags,
    ...imported.annotations.flatMap((row) => row.acousticTags)
  ]);
  const usedIds = new Set([
    ...project.speakers.map((item) => item.id),
    ...project.acousticTags.map((item) => item.id),
    ...project.annotations.map((item) => item.id)
  ]);
  const freshId = (): string => {
    const value = id();
    if (!value || usedIds.has(value)) throw new Error('Imported labels and annotations require a fresh unique ID');
    usedIds.add(value);
    return value;
  };
  const includeLabels = (existing: LabelDefinition[], labels: string[]): LabelDefinition[] => {
    const result = [...existing];
    for (const label of labels) {
      if (!result.some((item) => item.label === label)) result.push({ id: freshId(), label });
    }
    return result;
  };

  const speakers = includeLabels(project.speakers, speakerLabels);
  const acousticTags = includeLabels(project.acousticTags, tagLabels);
  const speakerId = (label: string | null): string | null => {
    const clean = cleanLabel(label ?? '');
    return clean ? speakers.find((item) => item.label === clean)?.id ?? null : null;
  };
  const tagIds = (labels: string[]): string[] => uniqueLabels(labels).map((label) =>
    acousticTags.find((item) => item.label === label)?.id
  ).filter((value): value is string => Boolean(value));

  const annotations: Annotation[] = imported.annotations.map((row) => {
    const portableDraft: AnnotationDraft = {
      startMs: row.startMs,
      endMs: row.endMs,
      eventType: row.eventType,
      transcription: row.transcription,
      intelligibility: row.intelligibility,
      speakerId: speakerId(row.speaker),
      overlap: row.overlap,
      confidence: row.confidence,
      acousticTagIds: tagIds(row.acousticTags),
      notes: row.notes
    };
    const draft = normalizeDraftForEventType(portableDraft, row.eventType);
    const candidate = { ...project, speakers, acousticTags };
    const errors = validateDraft(draft, candidate);
    const firstError = Object.values(errors)[0];
    if (firstError) throw new Error(`Imported annotation is invalid: ${firstError}`);
    return { ...draft, id: freshId(), createdAt: now, updatedAt: now };
  });

  return {
    ...project,
    speakers,
    acousticTags,
    annotations: [...project.annotations, ...annotations]
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  };
}
