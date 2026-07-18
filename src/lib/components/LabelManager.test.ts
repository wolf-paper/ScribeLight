import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import AcousticTagManager from './AcousticTagManager.svelte';
import SpeakerManager from './SpeakerManager.svelte';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('SpeakerManager', () => {
  it('adds and renames a speaker while persisting the stable ID', async () => {
    const saveProject = vi.fn(async () => undefined);
    const store = new ProjectStore({ saveProject });
    store.open(createProject(audio));
    render(SpeakerManager, { store });

    await fireEvent.input(screen.getByLabelText('New speaker'), { target: { value: 'narrator' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }));
    const added = get(store).project!.speakers.at(-1)!;
    expect(added.label).toBe('narrator');

    const rename = screen.getByLabelText('Rename narrator');
    await fireEvent.input(rename, { target: { value: 'host' } });
    await fireEvent.blur(rename);

    expect(get(store).project!.speakers.at(-1)).toEqual({ id: added.id, label: 'host' });
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ speakers: expect.arrayContaining([{ id: added.id, label: 'host' }]) }));
  });

  it('requires an explicit replacement before removing a referenced speaker', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'line' });
    await store.commitDraft();
    render(SpeakerManager, { store });

    const current = get(store).project!;
    const speaker = current.speakers[0];
    const replacement = current.speakers[1];
    const remove = screen.getByRole('button', { name: `Remove ${speaker.label}` });
    expect(remove).toBeDisabled();
    expect(screen.getByLabelText(`Reassign ${speaker.label}`)).not.toHaveTextContent(speaker.label);

    await fireEvent.change(screen.getByLabelText(`Reassign ${speaker.label}`), { target: { value: replacement.id } });
    await fireEvent.click(remove);

    expect(get(store).project).toMatchObject({
      annotations: [{ speakerId: replacement.id }],
      draft: { speakerId: replacement.id }
    });
    expect(get(store).project!.speakers.map((item) => item.id)).not.toContain(speaker.id);
  });

  it('keeps an invalid rename recoverable and exposes its error', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    render(SpeakerManager, { store });

    const first = get(store).project!.speakers[0];
    const rename = screen.getByLabelText(`Rename ${first.label}`);
    await fireEvent.input(rename, { target: { value: 'none' } });
    await fireEvent.blur(rename);

    expect(get(store).project!.speakers[0]).toEqual(first);
    expect(get(store).saveError).toBe('The label none is reserved');
    expect(screen.getByRole('alert')).toHaveTextContent('The label none is reserved');
  });
});

describe('AcousticTagManager', () => {
  it('adds and renames an acoustic tag', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    render(AcousticTagManager, { store });

    await fireEvent.input(screen.getByLabelText('New acoustic tag'), { target: { value: 'whisper' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add acoustic tag' }));
    const added = get(store).project!.acousticTags.at(-1)!;
    const rename = screen.getByLabelText('Rename whisper');
    await fireEvent.input(rename, { target: { value: 'aside' } });
    await fireEvent.blur(rename);

    expect(get(store).project!.acousticTags.at(-1)).toEqual({ id: added.id, label: 'aside' });
  });

  it('only removes a referenced tag after confirmation and clears every reference', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
    store.open(createProject(audio));
    const tag = get(store).project!.acousticTags[0];
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'line', acousticTagIds: [tag.id] });
    await store.commitDraft();
    render(AcousticTagManager, { store });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    await fireEvent.click(screen.getByRole('button', { name: `Remove ${tag.label}` }));
    expect(get(store).project!.acousticTags.map((item) => item.id)).toContain(tag.id);

    await fireEvent.click(screen.getByRole('button', { name: `Remove ${tag.label}` }));
    expect(get(store).project).toMatchObject({ annotations: [{ acousticTagIds: [] }], draft: { acousticTagIds: [] } });
    expect(get(store).project!.acousticTags.map((item) => item.id)).not.toContain(tag.id);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
