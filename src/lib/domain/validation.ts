import type { AnnotationDraft, EventType, Intelligibility, Project } from './types';

export type FieldErrors = Partial<Record<keyof AnnotationDraft, string>>;

export function normalizeIntelligibility(value: Intelligibility | 'intelligible'): Intelligibility {
  return value === 'intelligible' ? 'highly_intelligible' : value;
}

export function normalizeDraftForEventType(draft: AnnotationDraft, eventType: EventType): AnnotationDraft {
  if (eventType === 'speech') {
    return { ...draft, eventType, intelligibility: draft.intelligibility === 'not_applicable' ? 'highly_intelligible' : draft.intelligibility };
  }
  return { ...draft, eventType, transcription: '', intelligibility: 'not_applicable', speakerId: null, overlap: 'none' };
}

export function validateDraft(draft: AnnotationDraft, project: Project): FieldErrors {
  const errors: FieldErrors = {};
  if (!Number.isInteger(draft.startMs) || draft.startMs < 0) errors.startMs = 'Start must be a non-negative integer millisecond value';
  if (!Number.isInteger(draft.endMs) || draft.endMs <= draft.startMs) errors.endMs = 'End must be later than start';
  else if (draft.endMs > project.audioIdentity.durationMs) errors.endMs = 'End must not exceed the clip duration';
  if (draft.transcription.includes('\t')) errors.transcription = 'Transcription cannot contain tabs';
  if (draft.notes.includes('\t')) errors.notes = 'Notes cannot contain tabs';
  if (draft.eventType === 'speech') {
    if (!draft.speakerId || !project.speakers.some((speaker) => speaker.id === draft.speakerId)) errors.speakerId = 'A project speaker is required';
    if ((draft.intelligibility === 'highly_intelligible' || draft.intelligibility === 'partially_intelligible') && !draft.transcription.trim()) {
      errors.transcription = 'Transcription is required for intelligible speech';
    }
  }
  if (draft.acousticTagIds.some((id) => !project.acousticTags.some((tag) => tag.id === id))) errors.acousticTagIds = 'Every tag must exist in the project';
  return errors;
}
