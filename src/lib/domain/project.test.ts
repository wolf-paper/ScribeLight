import { describe, expect, it } from 'vitest';
import { createProject, DEFAULT_TAG_LABELS } from './project';

describe('createProject', () => {
  it('seeds editable speakers and tags', () => {
    const project = createProject({
      canonicalPath: 'clip.wav', size: 10, modifiedMs: 1, durationMs: 240_000,
      sampleRate: 48_000, channels: 1
    });
    expect(project.speakers.map((item) => item.label)).toEqual(['speaker_1', 'speaker_2', 'speaker_3']);
    expect(project.acousticTags.map((item) => item.label)).toEqual([...DEFAULT_TAG_LABELS]);
    expect(project.draft.speakerId).toBe(project.speakers[0].id);
    expect(project.draft.intelligibility).toBe('highly_intelligible');
  });
});
