import { describe, expect, it } from 'vitest';
import { createProject } from './project';
import { normalizeDraftForEventType, validateDraft } from './validation';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('annotation validation', () => {
  it('requires an ordered in-bounds selection and transcription for intelligible speech', () => {
    const project = createProject(audio);
    const errors = validateDraft({
      ...project.draft,
      startMs: 500,
      endMs: 500,
      transcription: '',
      intelligibility: 'highly_intelligible'
    }, project);
    expect(errors.endMs).toContain('later');
    expect(errors.transcription).toContain('required');
  });

  it('requires transcription for partially intelligible speech', () => {
    const project = createProject(audio);
    const errors = validateDraft({
      ...project.draft,
      startMs: 100,
      endMs: 200,
      transcription: '',
      intelligibility: 'partially_intelligible'
    }, project);

    expect(errors.transcription).toContain('required');
  });

  it('normalizes non-speech fields', () => {
    const project = createProject(audio);
    const result = normalizeDraftForEventType({ ...project.draft, transcription: 'words' }, 'non_speech');
    expect(result).toMatchObject({ eventType: 'non_speech', transcription: '', intelligibility: 'not_applicable', speakerId: null });
  });

  it('requires a current speaker for speech and current tags for all events', () => {
    const project = createProject(audio);
    const errors = validateDraft({ ...project.draft, speakerId: 'missing', acousticTagIds: ['missing'] }, project);
    expect(errors.speakerId).toContain('required');
    expect(errors.acousticTagIds).toContain('exist');
  });

  it('rejects out-of-bounds or fractional boundaries and tabs in text fields', () => {
    const project = createProject(audio);
    const errors = validateDraft({
      ...project.draft,
      startMs: 0.5,
      endMs: 1001,
      transcription: 'tab\ttext',
      notes: 'tab\tnote'
    }, project);
    expect(errors.startMs).toContain('integer');
    expect(errors.endMs).toContain('duration');
    expect(errors.transcription).toContain('tabs');
    expect(errors.notes).toContain('tabs');
  });

  it('restores a usable speech intelligibility value', () => {
    const project = createProject(audio);
    const result = normalizeDraftForEventType({ ...project.draft, intelligibility: 'not_applicable' }, 'speech');
    expect(result.intelligibility).toBe('highly_intelligible');
  });
});
