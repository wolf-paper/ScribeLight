import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import SettingsDialog from './SettingsDialog.svelte';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

function renderSettings(store: ProjectStore) {
  return render(SettingsDialog, {
    store,
    palette: 'ion-magenta',
    multilinePolicy: 'escape',
    onpalette: vi.fn(),
    onpolicy: vi.fn(),
    onclose: vi.fn()
  });
}

describe('SpeakerManager', () => {
  it('adds and renames a speaker while persisting the stable ID', async () => {
    const saveProject = vi.fn(async () => undefined);
    const store = new ProjectStore({ saveProject });
    store.open(createProject(audio));
    renderSettings(store);

    await fireEvent.input(screen.getByLabelText('New speaker'), { target: { value: 'narrator' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }));
    await waitFor(() => expect(get(store).project!.speakers.at(-1)!.label).toBe('narrator'));
    const added = get(store).project!.speakers.at(-1)!;
    expect(added.label).toBe('narrator');

    const rename = await screen.findByLabelText('Rename narrator');
    await fireEvent.input(rename, { target: { value: 'host' } });
    await fireEvent.blur(rename);

    await waitFor(() => expect(get(store).project!.speakers.at(-1)).toEqual({ id: added.id, label: 'host' }));
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ speakers: expect.arrayContaining([{ id: added.id, label: 'host' }]) }));
  });

  it('requires an explicit replacement before removing a referenced speaker', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'line' });
    await store.commitDraft();
    renderSettings(store);

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
    renderSettings(store);

    const first = get(store).project!.speakers[0];
    const rename = screen.getByLabelText(`Rename ${first.label}`);
    await fireEvent.input(rename, { target: { value: 'none' } });
    await fireEvent.blur(rename);

    expect(get(store).project!.speakers[0]).toEqual(first);
    expect(get(store).saveError).toBe('The label none is reserved');
    expect(screen.getByRole('alert')).toHaveTextContent('The label none is reserved');
  });

  it('rejects tabs inline when adding and renaming speakers', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    renderSettings(store);

    await fireEvent.input(screen.getByLabelText('New speaker'), { target: { value: 'guest\tname' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Speaker labels cannot contain tabs');

    const first = get(store).project!.speakers[0];
    const rename = screen.getByLabelText(`Rename ${first.label}`);
    await fireEvent.input(rename, { target: { value: 'host\tname' } });
    await fireEvent.blur(rename);
    expect(screen.getByRole('alert')).toHaveTextContent('Speaker labels cannot contain tabs');
    expect(get(store).project!.speakers[0]).toEqual(first);
  });
});

describe('AcousticTagManager', () => {
  it('adds and renames an acoustic tag', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    renderSettings(store);

    await fireEvent.input(screen.getByLabelText('New acoustic tag'), { target: { value: 'whisper' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add acoustic tag' }));
    await waitFor(() => expect(get(store).project!.acousticTags.at(-1)!.label).toBe('whisper'));
    const added = get(store).project!.acousticTags.at(-1)!;
    const rename = await screen.findByLabelText('Rename whisper');
    await fireEvent.input(rename, { target: { value: 'aside' } });
    await fireEvent.blur(rename);

    await waitFor(() => expect(get(store).project!.acousticTags.at(-1)).toEqual({ id: added.id, label: 'aside' }));
  });

  it('only removes a referenced tag after confirmation and clears every reference', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
    store.open(createProject(audio));
    const tag = get(store).project!.acousticTags[0];
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'line', acousticTagIds: [tag.id] });
    await store.commitDraft();
    renderSettings(store);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    await fireEvent.click(screen.getByRole('button', { name: `Remove ${tag.label}` }));
    expect(get(store).project!.acousticTags.map((item) => item.id)).toContain(tag.id);

    await fireEvent.click(screen.getByRole('button', { name: `Remove ${tag.label}` }));
    expect(get(store).project).toMatchObject({ annotations: [{ acousticTagIds: [] }], draft: { acousticTagIds: [] } });
    expect(get(store).project!.acousticTags.map((item) => item.id)).not.toContain(tag.id);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['tab', 'room\ttone', 'Acoustic tag labels cannot contain tabs'],
    ['semicolon', 'music;effects', 'Acoustic tag labels cannot contain semicolons']
  ])('rejects a %s inline when adding and renaming acoustic tags', async (_kind, invalid, message) => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject(audio));
    renderSettings(store);

    await fireEvent.input(screen.getByLabelText('New acoustic tag'), { target: { value: invalid } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add acoustic tag' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);

    const first = get(store).project!.acousticTags[0];
    const rename = screen.getByLabelText(`Rename ${first.label}`);
    await fireEvent.input(rename, { target: { value: invalid } });
    await fireEvent.blur(rename);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(get(store).project!.acousticTags[0]).toEqual(first);
  });
});
