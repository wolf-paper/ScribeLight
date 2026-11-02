import { describe, expect, it } from 'vitest';
import type { ImportedTsv } from '../bridge/native';
import { createProject } from './project';
import { mergeImportedTsv } from './importTsv';
import { worksheetErrors } from './validation';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1_000, sampleRate: 1_000, channels: 1 };
const speech = (startMs: number, endMs: number, transcription: string, speaker = 'guest') => ({
  startMs, endMs, eventType: 'speech' as const, transcription,
  intelligibility: 'intelligible' as const, speaker, overlap: 'overlap' as const,
  confidence: 'high' as const, acousticTags: ['laugh'], notes: ''
});

describe('mergeImportedTsv', () => {
  it('reuses exact stable label IDs, discovers omitted row labels once, and preserves overlaps', () => {
    const project = createProject(audio);
    project.speakers[0].label = 'guest';
    const laugh = project.acousticTags.find((item) => item.label === 'laugh')!;
    project.annotations.push({
      ...project.draft, id: 'existing', startMs: 15, endMs: 35, transcription: 'existing',
      speakerId: project.speakers[0].id, createdAt: 'old', updatedAt: 'old'
    });
    let serial = 0;
    const merged = mergeImportedTsv(project, {
      speakers: [], acousticTags: [],
      annotations: [speech(10, 30, 'one'), speech(20, 40, 'two')]
    }, () => `import-${++serial}`, '2026-01-01T00:00:00Z');

    expect(merged.speakers.filter((item) => item.label === 'guest')).toHaveLength(1);
    expect(merged.acousticTags.filter((item) => item.label === 'laugh')).toHaveLength(1);
    expect(merged.annotations).toHaveLength(3);
    expect(merged.annotations.find((item) => item.id === 'existing')).toBe(project.annotations[0]);
    expect(merged.annotations.filter((item) => item.id !== 'existing')).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerId: project.speakers[0].id, acousticTagIds: [laugh.id] })
    ]));
  });

  it('adds valid summary and row labels without blank, none, or duplicate definitions', () => {
    const project = createProject(audio);
    let serial = 0;
    const merged = mergeImportedTsv(project, {
      speakers: [' guest ', 'guest', '', 'none'], acousticTags: [' laugh ', 'laugh', 'none'],
      annotations: [speech(10, 20, 'hello')]
    }, () => `id-${++serial}`);

    expect(merged.speakers.filter((item) => item.label === 'guest')).toHaveLength(1);
    expect(merged.acousticTags.filter((item) => item.label === 'laugh')).toHaveLength(1);
    expect(merged.speakers.some((item) => !item.label || item.label === 'none')).toBe(false);
  });

  it('normalizes legacy intelligible rows to the canonical value', () => {
    const project = createProject(audio);
    const merged = mergeImportedTsv(project, {
      speakers: ['guest'], acousticTags: [], annotations: [speech(10, 20, 'legacy')]
    }, () => crypto.randomUUID());

    expect(merged.annotations[0].intelligibility).toBe('highly_intelligible');
  });

  it('keeps blank review labels and speech not_applicable unset for review instead of rejecting the file', () => {
    const project = createProject(audio);
    const merged = mergeImportedTsv(project, {
      speakers: [], acousticTags: [],
      annotations: [
        { ...speech(10, 20, 'subtitle cue'), intelligibility: null, speaker: null, overlap: null, confidence: null, acousticTags: [] },
        { ...speech(30, 40, 'drum roll'), intelligibility: 'not_applicable' }
      ]
    }, () => crypto.randomUUID());

    expect(merged.annotations[0]).toMatchObject({ intelligibility: null, speakerId: null, overlap: null, confidence: null });
    expect(merged.annotations[1]).toMatchObject({ intelligibility: null, overlap: 'overlap', confidence: 'high' });
    expect(merged.annotations[1].speakerId).toBe(merged.speakers.find((item) => item.label === 'guest')!.id);
  });

  it('rejects malformed enums and boundaries but imports Yamabiko rule violations flagged for review', () => {
    const project = createProject(audio);
    const imported: ImportedTsv = {
      speakers: ['guest'], acousticTags: ['laugh'],
      annotations: [speech(10, 20, 'valid'), { ...speech(20, 30, 'bad'), confidence: 'certain' as 'high' }]
    };
    expect(() => mergeImportedTsv(project, imported)).toThrow('confidence');
    expect(project.annotations).toEqual([]);
    const flagged = mergeImportedTsv(project, { ...imported, annotations: [{ ...speech(10, 20, ''), transcription: ' ' }] });
    expect(worksheetErrors(flagged.annotations[0], flagged)).toMatchObject({
      speakerId: 'Rename speaker guest to speaker_<number>',
      transcription: 'Transcription is required for intelligible speech',
      overlap: 'Overlap and the overlap tag must agree'
    });
    expect(() => mergeImportedTsv(project, { ...imported, annotations: [speech(900, 1_001, 'outside')] })).toThrow('End');
  });

  it('normalizes non-speech portable fields through the existing domain semantics', () => {
    const project = createProject(audio);
    const merged = mergeImportedTsv(project, {
      speakers: ['unused'], acousticTags: ['noise'], annotations: [{
        startMs: 1, endMs: 2, eventType: 'non_speech', transcription: 'discard',
        intelligibility: 'intelligible', speaker: 'unused', overlap: 'overlap', confidence: 'low',
        acousticTags: ['noise'], notes: 'door'
      }]
    }, () => crypto.randomUUID());

    expect(merged.annotations[0]).toMatchObject({
      eventType: 'non_speech', transcription: '', intelligibility: 'not_applicable', speakerId: null, overlap: 'none'
    });
  });

  it('requires injected IDs to remain fresh before returning a new project', () => {
    const project = createProject(audio);
    expect(() => mergeImportedTsv(project, {
      speakers: ['guest'], acousticTags: [], annotations: [speech(10, 20, 'one')]
    }, () => 'duplicate')).toThrow('unique ID');
    expect(project.annotations).toEqual([]);
  });
});
