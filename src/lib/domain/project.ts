import type { AnnotationDraft, AudioIdentity, LabelDefinition, Project } from './types';

export const DEFAULT_TAG_LABELS = [
  'quiet_dialogue', 'loud_dialogue', 'high_f0_nonmodal', 'overlap', 'music',
  'effects_noise', 'music_effects_noise', 'rapid_turns', 'short_acknowledgements',
  'long_endpoint', 'non_speech_control', 'background_speech', 'singing', 'laugh',
  'breath', 'incomplete_word'
] as const;

const label = (value: string): LabelDefinition => ({ id: crypto.randomUUID(), label: value });

export function emptyDraft(): AnnotationDraft {
  return {
    startMs: 0, endMs: 0, eventType: 'speech', transcription: '',
    intelligibility: 'intelligible', speakerId: null, overlap: 'none',
    confidence: 'high', acousticTagIds: [], notes: ''
  };
}

export function createProject(audioIdentity: AudioIdentity): Project {
  const speakers = ['speaker_1', 'speaker_2', 'speaker_3'].map(label);
  return {
    schemaVersion: 1,
    audioIdentity,
    displayFormat: 'seconds',
    speakers,
    acousticTags: DEFAULT_TAG_LABELS.map(label),
    annotations: [],
    draft: { ...emptyDraft(), speakerId: speakers[0].id },
    activeAnnotationId: null,
    activeSelection: null,
    exportSettings: { multilinePolicy: 'escape' }
  };
}
