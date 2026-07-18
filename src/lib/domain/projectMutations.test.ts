import { describe, expect, it } from 'vitest';
import { addLabel, createProject, removeSpeaker, removeTag, renameSpeaker, renameTag } from './project';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('project label mutations', () => {
  it('renames labels through stable IDs', () => {
    let project = createProject(audio);
    project = renameSpeaker(project, project.speakers[0].id, 'narrator');
    project = renameTag(project, project.acousticTags[0].id, 'whisper');
    expect(project.speakers[0].label).toBe('narrator');
    expect(project.acousticTags[0].label).toBe('whisper');
  });

  it('creates only non-reserved, unique editable labels', () => {
    const project = createProject(audio);
    expect(() => addLabel(project, 'speakers', ' none ')).toThrow('reserved');
    expect(() => addLabel(project, 'speakers', ' speaker_1 ')).toThrow('unique');
    const result = addLabel(project, 'speakers', ' narrator ');
    expect(result.speakers.at(-1)?.label).toBe('narrator');
    expect(project.speakers).toHaveLength(3);
  });

  it('requires speaker reassignment when referenced', () => {
    const project = createProject(audio);
    const used = project.speakers[0].id;
    const reassigned = project.speakers[1].id;
    project.annotations.push({ ...project.draft, id: 'a', speakerId: used, startMs: 1, endMs: 2, createdAt: 'x', updatedAt: 'x' });
    expect(() => removeSpeaker(project, used)).toThrow('reassignment');
    expect(removeSpeaker(project, used, reassigned).annotations[0].speakerId).toBe(reassigned);
  });

  it('requires reassignment when only the draft references a speaker', () => {
    const project = createProject(audio);
    const used = project.speakers[0].id;
    const reassigned = project.speakers[1].id;
    expect(() => removeSpeaker(project, used)).toThrow('reassignment');
    expect(removeSpeaker(project, used, reassigned).draft.speakerId).toBe(reassigned);
  });

  it('removes a confirmed referenced tag from annotations', () => {
    const project = createProject(audio);
    const tagId = project.acousticTags[0].id;
    project.annotations.push({ ...project.draft, id: 'a', acousticTagIds: [tagId], startMs: 1, endMs: 2, createdAt: 'x', updatedAt: 'x' });
    expect(() => removeTag(project, tagId, false)).toThrow('confirmation');
    expect(removeTag(project, tagId, true).annotations[0].acousticTagIds).toEqual([]);
  });

  it('requires confirmation when only the draft references a tag', () => {
    const project = createProject(audio);
    const tagId = project.acousticTags[0].id;
    project.draft.acousticTagIds = [tagId];
    expect(() => removeTag(project, tagId, false)).toThrow('confirmation');
    expect(removeTag(project, tagId, true).draft.acousticTagIds).toEqual([]);
  });

  it('rejects an invalid replacement speaker', () => {
    const project = createProject(audio);
    expect(() => removeSpeaker(project, project.speakers[0].id, 'missing')).toThrow('does not exist');
    expect(() => removeSpeaker(project, project.speakers[0].id, project.speakers[0].id)).toThrow('does not exist');
  });
});
