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

function requireUniqueLabel(items: LabelDefinition[], nextLabel: string, exceptId?: string): string {
  const normalized = nextLabel.trim();
  if (!normalized) throw new Error('Label cannot be empty');
  if (normalized === 'none') throw new Error('The label none is reserved');
  if (items.some((item) => item.id !== exceptId && item.label === normalized)) throw new Error('Label must be unique');
  return normalized;
}

export function addLabel(project: Project, kind: 'speakers' | 'acousticTags', nextLabel: string): Project {
  const value = requireUniqueLabel(project[kind], nextLabel);
  return { ...project, [kind]: [...project[kind], label(value)] };
}

export function renameSpeaker(project: Project, id: string, nextLabel: string): Project {
  const value = requireUniqueLabel(project.speakers, nextLabel, id);
  return { ...project, speakers: project.speakers.map((item) => item.id === id ? { ...item, label: value } : item) };
}

export function renameTag(project: Project, id: string, nextLabel: string): Project {
  const value = requireUniqueLabel(project.acousticTags, nextLabel, id);
  return { ...project, acousticTags: project.acousticTags.map((item) => item.id === id ? { ...item, label: value } : item) };
}

export function removeSpeaker(project: Project, id: string, reassignTo?: string): Project {
  const referenced = project.annotations.some((annotation) => annotation.speakerId === id);
  if (referenced && !reassignTo) throw new Error('Speaker reassignment is required');
  if (reassignTo && !project.speakers.some((speaker) => speaker.id === reassignTo && speaker.id !== id)) {
    throw new Error('Reassignment target does not exist');
  }
  return {
    ...project,
    speakers: project.speakers.filter((speaker) => speaker.id !== id),
    annotations: project.annotations.map((annotation) => annotation.speakerId === id ? { ...annotation, speakerId: reassignTo ?? null } : annotation),
    draft: project.draft.speakerId === id ? { ...project.draft, speakerId: reassignTo ?? null } : project.draft
  };
}

export function removeTag(project: Project, id: string, confirmed: boolean): Project {
  const referenced = project.annotations.some((annotation) => annotation.acousticTagIds.includes(id));
  if (referenced && !confirmed) throw new Error('Tag removal requires confirmation');
  return {
    ...project,
    acousticTags: project.acousticTags.filter((tag) => tag.id !== id),
    annotations: project.annotations.map((annotation) => ({ ...annotation, acousticTagIds: annotation.acousticTagIds.filter((tagId) => tagId !== id) })),
    draft: { ...project.draft, acousticTagIds: project.draft.acousticTagIds.filter((tagId) => tagId !== id) }
  };
}
