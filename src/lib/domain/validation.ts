import { YAMABIKO_SPEAKER, YAMABIKO_TAGS } from './project';
import type { AnnotationDraft, EventType, Intelligibility, Project } from './types';

export type FieldErrors = Partial<Record<keyof AnnotationDraft, string>>;

export function normalizeIntelligibility(value: Intelligibility | 'intelligible' | null): Intelligibility | null {
  return value === 'intelligible' ? 'highly_intelligible' : value;
}

export function normalizeDraftForEventType(draft: AnnotationDraft, eventType: EventType): AnnotationDraft {
  if (eventType === 'speech') {
    return { ...draft, eventType, intelligibility: draft.intelligibility === 'not_applicable' ? 'highly_intelligible' : draft.intelligibility };
  }
  return { ...draft, eventType, transcription: '', intelligibility: 'not_applicable', speakerId: null, overlap: 'none' };
}

// Characters removed by Yamabiko's normalize_minimal: Python str.isspace() plus Unicode P* and S*.
const unscorable = /[\p{White_Space}\x1c-\x1f\p{P}\p{S}]/gu;

/**
 * Every rule Yamabiko's worksheet import (`annotations.py` `_parse_row`, speech-text-required passes)
 * would reject this row for, keyed by the field to fix. Empty when Yamabiko will accept the row.
 */
export function worksheetErrors(draft: AnnotationDraft, project: Project): FieldErrors {
  const errors: FieldErrors = {};
  const tags = draft.acousticTagIds.flatMap((id) => project.acousticTags.find((tag) => tag.id === id)?.label ?? []);
  const unknownTags = tags.filter((tag) => !(YAMABIKO_TAGS as readonly string[]).includes(tag));

  if (!draft.intelligibility) errors.intelligibility = 'Choose an intelligibility';
  if (!draft.overlap) errors.overlap = 'Choose an overlap value';
  else if ((draft.overlap === 'overlap') !== tags.includes('overlap')) errors.overlap = 'Overlap and the overlap tag must agree';
  if (!draft.confidence) errors.confidence = 'Choose a confidence';
  if (unknownTags.length) errors.acousticTagIds = `Not a Yamabiko acoustic tag: ${unknownTags.join(', ')}`;
  else if (tags.includes('music_effects_noise') && (tags.includes('music') || tags.includes('effects_noise'))) {
    errors.acousticTagIds = 'music_effects_noise cannot be combined with music or effects_noise';
  } else if (tags.includes('code_switch') && tags.includes('non_japanese_speech')) {
    errors.acousticTagIds = 'code_switch cannot be combined with non_japanese_speech';
  }
  if (/[\r\n]/.test(draft.transcription)) errors.transcription = 'Transcription must stay on one line';
  if (/[\r\n]/.test(draft.notes)) errors.notes = 'Notes must stay on one line';

  if (draft.eventType === 'speech') {
    const speaker = project.speakers.find((item) => item.id === draft.speakerId)?.label;
    if (!draft.speakerId) errors.speakerId = 'Choose a speaker';
    else if (speaker && !YAMABIKO_SPEAKER.test(speaker)) errors.speakerId = `Rename speaker ${speaker} to speaker_<number>`;
    if (draft.intelligibility === 'not_applicable') errors.intelligibility = 'Speech cannot be Not applicable';
    if (!errors.transcription) {
      if (draft.intelligibility === 'highly_intelligible' || draft.intelligibility === 'partially_intelligible') {
        if (!draft.transcription.trim()) errors.transcription = 'Transcription is required for intelligible speech';
        else if (draft.intelligibility === 'highly_intelligible' && !draft.transcription.normalize('NFKC').replace(unscorable, '')) {
          errors.transcription = 'Intelligible speech needs at least one letter, kana, kanji, or digit';
        }
      } else if (draft.intelligibility === 'unintelligible' && draft.transcription) {
        errors.transcription = 'Unintelligible speech must have an empty transcription';
      }
    }
    if (tags.includes('non_speech_control')) errors.acousticTagIds ??= 'non_speech_control only applies to non-speech';
  } else {
    if (draft.transcription) errors.transcription ??= 'Non-speech must have an empty transcription';
    if (draft.intelligibility && draft.intelligibility !== 'not_applicable') errors.intelligibility = 'Non-speech intelligibility must be Not applicable';
    if (draft.speakerId) errors.speakerId = 'Non-speech has no speaker';
    if (draft.overlap === 'overlap') errors.overlap = 'Non-speech overlap must be None';
  }
  return errors;
}

/**
 * Rules that block storing an annotation at all. Yamabiko's worksheet rules (`worksheetErrors`) never
 * block saving; they only flag an annotation as needing review.
 */
export function validateDraft(draft: AnnotationDraft, project: Project): FieldErrors {
  const errors: FieldErrors = {};
  if (!Number.isInteger(draft.startMs) || draft.startMs < 0) errors.startMs = 'Start must be a non-negative integer millisecond value';
  if (!Number.isInteger(draft.endMs) || draft.endMs <= draft.startMs) errors.endMs = 'End must be later than start';
  else if (draft.endMs > project.audioIdentity.durationMs) errors.endMs = 'End must not exceed the clip duration';
  if (draft.transcription.includes('\t')) errors.transcription = 'Transcription cannot contain tabs';
  if (draft.notes.includes('\t')) errors.notes = 'Notes cannot contain tabs';
  if (draft.speakerId && !project.speakers.some((speaker) => speaker.id === draft.speakerId)) errors.speakerId = 'A project speaker is required';
  if (draft.acousticTagIds.some((id) => !project.acousticTags.some((tag) => tag.id === id))) errors.acousticTagIds = 'Every tag must exist in the project';
  return errors;
}
