import { describe, expect, it } from 'vitest';
import { createProject } from './project';
import type { AnnotationDraft } from './types';
import { normalizeDraftForEventType, validateDraft, worksheetErrors } from './validation';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('annotation validation', () => {
  it('requires an ordered in-bounds selection', () => {
    const project = createProject(audio);
    expect(validateDraft({ ...project.draft, startMs: 500, endMs: 500 }, project).endMs).toContain('later');
  });

  it('requires transcription for intelligible and partially intelligible speech', () => {
    const project = createProject(audio);
    for (const intelligibility of ['highly_intelligible', 'partially_intelligible'] as const) {
      const errors = worksheetErrors({ ...project.draft, startMs: 100, endMs: 200, transcription: '', intelligibility }, project);
      expect(errors.transcription).toContain('required');
    }
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

describe('Yamabiko worksheet rules', () => {
  const project = createProject(audio);
  const tags = (...labels: string[]) => labels.map((label) => project.acousticTags.find((tag) => tag.label === label)!.id);
  const speech: AnnotationDraft = { ...project.draft, startMs: 100, endMs: 200, transcription: 'うん' };
  const nonSpeech = normalizeDraftForEventType(speech, 'non_speech');

  it('accepts complete speech and non-speech rows', () => {
    expect(worksheetErrors(speech, project)).toEqual({});
    expect(worksheetErrors({ ...speech, overlap: 'overlap', acousticTagIds: tags('overlap', 'music') }, project)).toEqual({});
    expect(worksheetErrors({ ...speech, intelligibility: 'unintelligible', transcription: '' }, project)).toEqual({});
    expect(worksheetErrors({ ...nonSpeech, acousticTagIds: tags('effects_noise', 'non_speech_control') }, project)).toEqual({});
  });

  const violations: [string, Partial<AnnotationDraft>, keyof AnnotationDraft, string][] = [
    ['symbol-only intelligible text', { transcription: '~♪' }, 'transcription', 'letter, kana, kanji, or digit'],
    ['text on unintelligible speech', { intelligibility: 'unintelligible', transcription: 'ジャオー' }, 'transcription', 'empty transcription'],
    ['not_applicable speech', { intelligibility: 'not_applicable' }, 'intelligibility', 'cannot be Not applicable'],
    ['overlap without its tag', { overlap: 'overlap' }, 'overlap', 'must agree'],
    ['the overlap tag without overlap', { acousticTagIds: tags('overlap') }, 'overlap', 'must agree'],
    ['music_effects_noise with music', { acousticTagIds: tags('music_effects_noise', 'music') }, 'acousticTagIds', 'cannot be combined'],
    ['code_switch with non_japanese_speech', { acousticTagIds: tags('code_switch', 'non_japanese_speech') }, 'acousticTagIds', 'cannot be combined'],
    ['non_speech_control on speech', { acousticTagIds: tags('non_speech_control') }, 'acousticTagIds', 'only applies to non-speech'],
    ['a line break in notes', { notes: 'two\nlines' }, 'notes', 'one line'],
    ['an unset confidence', { confidence: null }, 'confidence', 'Choose a confidence']
  ];

  it.each(violations)('flags %s without blocking the save', (_case, patch, field, message) => {
    expect(worksheetErrors({ ...speech, ...patch }, project)[field]).toContain(message);
    expect(validateDraft({ ...speech, ...patch }, project)).toEqual({});
  });

  it('flags non-Yamabiko labels and an overlap tag on non-speech', () => {
    const custom = {
      ...project,
      speakers: [...project.speakers, { id: 'tatewaku', label: 'Tatewaku' }],
      acousticTags: [...project.acousticTags, { id: 'combo', label: 'music, singing' }]
    };
    expect(worksheetErrors({ ...speech, speakerId: 'tatewaku', acousticTagIds: ['combo'] }, custom)).toMatchObject({
      speakerId: 'Rename speaker Tatewaku to speaker_<number>',
      acousticTagIds: 'Not a Yamabiko acoustic tag: music, singing'
    });
    expect(worksheetErrors({ ...nonSpeech, acousticTagIds: tags('overlap', 'effects_noise') }, project).overlap).toContain('must agree');
  });
});
