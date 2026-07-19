import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import type { Project } from '../domain/types';
import { ProjectStore } from './projectStore';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('ProjectStore', () => {
  const bridge = { saveProject: vi.fn<(project: Project) => Promise<void>>(async () => undefined) };

  beforeEach(() => {
    bridge.saveProject.mockReset();
    bridge.saveProject.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('adds then updates the same annotation identity', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'one' });
    await store.commitDraft('2026-01-01T00:00:00Z');
    const id = get(store).project!.annotations[0].id;
    store.patchDraft({ transcription: 'two' });
    await store.commitDraft('2026-01-01T00:00:01Z');

    expect(get(store).project!.annotations).toHaveLength(1);
    expect(get(store).project!.annotations[0]).toMatchObject({
      id,
      transcription: 'two',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:01Z'
    });
    vi.advanceTimersByTime(350);
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
  });

  it('keeps an invalid draft local and exposes its field errors', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ startMs: 20, endMs: 10 });

    await expect(store.commitDraft()).resolves.toBe(false);
    expect(get(store).errors).toMatchObject({ endMs: 'End must be later than start' });
    expect(bridge.saveProject).not.toHaveBeenCalled();
  });

  it('persists a draft after the recovery debounce', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'recover me' });
    vi.advanceTimersByTime(350);

    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending recovery write before close', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'close safely' });
    await expect(store.flush()).resolves.toBe(true);

    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(350);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
  });

  it('serializes a recovery write before the later commit snapshot', async () => {
    const recovery = deferred<void>();
    const saved = [] as ReturnType<typeof createProject>[];
    bridge.saveProject.mockImplementation((project) => {
      saved.push(project);
      return saved.length === 1 ? recovery.promise : Promise.resolve();
    });
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ notes: 'recovery snapshot' });
    vi.advanceTimersByTime(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'committed snapshot' });
    const commit = store.commitDraft('2026-01-01T00:00:00Z');
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    recovery.resolve();
    await commit;

    expect(saved).toHaveLength(2);
    expect(saved[1].annotations).toMatchObject([{ id: 'event-1', transcription: 'committed snapshot' }]);
  });

  it('continues saving after a rejected request', async () => {
    bridge.saveProject.mockRejectedValueOnce(new Error('disk full'));
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'failed save' });
    await expect(store.flush()).resolves.toBe(false);
    store.patchDraft({ notes: 'later save' });
    await expect(store.flush()).resolves.toBe(true);

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(get(store)).toMatchObject({
      project: { draft: { notes: 'later save' } },
      saveError: 'Error: disk full'
    });
  });

  it('cancels recovery when opening another project', () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'old project' });
    store.open(createProject({ ...audio, canonicalPath: 'b.wav' }));

    vi.advanceTimersByTime(350);

    expect(bridge.saveProject).not.toHaveBeenCalled();
  });

  it('copies selection integer boundaries into the draft', () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.setSelection({ startMs: 12, endMs: 34 });

    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 12, endMs: 34 },
      draft: { startMs: 12, endMs: 34 }
    });
  });

  it('restores a selected annotation into the editor and selection', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    const speakerId = get(store).project!.speakers[1].id;
    const acousticTagId = get(store).project!.acousticTags[1].id;
    store.patchDraft({
      startMs: 10,
      endMs: 20,
      eventType: 'speech',
      transcription: 'restore me',
      intelligibility: 'partially_intelligible',
      speakerId,
      overlap: 'overlap',
      confidence: 'low',
      acousticTagIds: [acousticTagId],
      notes: 'all fields'
    });
    await store.commitDraft('2026-01-01T00:00:00Z');
    store.clearDraft();
    store.selectAnnotation('event-1');

    expect(get(store).project).toMatchObject({
      activeAnnotationId: 'event-1',
      activeSelection: { startMs: 10, endMs: 20 },
      draft: {
        startMs: 10,
        endMs: 20,
        eventType: 'speech',
        transcription: 'restore me',
        intelligibility: 'partially_intelligible',
        speakerId,
        overlap: 'overlap',
        confidence: 'low',
        acousticTagIds: [acousticTagId],
        notes: 'all fields'
      }
    });
  });

  it('removes an annotation and clears it from the editor', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'remove me' });
    await store.commitDraft('2026-01-01T00:00:00Z');
    await store.removeAnnotation('event-1');

    expect(get(store).project!.annotations).toEqual([]);
    expect(get(store).project!.activeAnnotationId).toBeNull();
  });

  it('keeps local project state and exposes a save failure', async () => {
    bridge.saveProject.mockRejectedValueOnce(new Error('disk full'));
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'do not lose me' });

    await expect(store.flush()).resolves.toBe(false);

    expect(get(store)).toMatchObject({
      project: { draft: { notes: 'do not lose me' } },
      saveError: 'Error: disk full'
    });
  });

  it('does not publish a committed mutation when its atomic save fails', async () => {
    bridge.saveProject.mockRejectedValueOnce(new Error('disk full'));
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    await expect(store.mutateProject((project) => ({
      ...project,
      displayFormat: 'clock'
    }))).resolves.toBe(false);

    expect(get(store)).toMatchObject({
      project: { displayFormat: 'seconds' },
      saveError: 'Error: disk full'
    });
  });

  it('serializes committed mutations so each derives from the latest published project', async () => {
    const firstSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => firstSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    const first = store.mutateProject((project) => ({ ...project, draft: { ...project.draft, notes: 'first' } }));
    const second = store.mutateProject((project) => ({ ...project, draft: { ...project.draft, notes: `${project.draft.notes} second` } }));
    await Promise.resolve();
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
    firstSave.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(get(store).project!.draft.notes).toBe('first second');
    expect(bridge.saveProject.mock.calls[1][0].draft.notes).toBe('first second');
  });

  it('preserves newer draft and selection edits while a committed mutation save is unresolved', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    const mutation = store.mutateProject((project) => ({ ...project, displayFormat: 'clock' }));
    store.patchDraft({ notes: 'typed while saving' });
    store.setSelection({ startMs: 12, endMs: 34 });
    await vi.advanceTimersByTimeAsync(300);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(get(store).project).toMatchObject({
      displayFormat: 'clock',
      activeSelection: { startMs: 12, endMs: 34 },
      draft: { startMs: 12, endMs: 34, notes: 'typed while saving' }
    });
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      displayFormat: 'clock',
      activeSelection: { startMs: 12, endMs: 34 },
      draft: expect.objectContaining({ startMs: 12, endMs: 34, notes: 'typed while saving' })
    }));
  });

  it('persists a selected annotation merged while a committed mutation save is unresolved', async () => {
    const project = createProject(audio);
    project.annotations.push({
      ...project.draft,
      id: 'saved-annotation',
      startMs: 40,
      endMs: 80,
      transcription: 'selected while saving',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    });
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(project);

    const mutation = store.mutateProject((value) => ({ ...value, displayFormat: 'clock' }));
    store.selectAnnotation('saved-annotation');
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      displayFormat: 'clock',
      activeAnnotationId: 'saved-annotation',
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({
        startMs: 40,
        endMs: 80,
        transcription: 'selected while saving'
      })
    }));
  });

  it('persists a cleared editor merged while a committed mutation save is unresolved', async () => {
    const project = createProject(audio);
    project.activeAnnotationId = 'saved-annotation';
    project.activeSelection = { startMs: 40, endMs: 80 };
    project.draft = { ...project.draft, startMs: 40, endMs: 80, transcription: 'clear while saving' };
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(project);

    const mutation = store.mutateProject((value) => ({ ...value, displayFormat: 'clock' }));
    store.clearDraft();
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      displayFormat: 'clock',
      activeAnnotationId: null,
      activeSelection: null,
      draft: expect.objectContaining({ startMs: 0, endMs: 0, transcription: '' })
    }));
  });

  it('recovers a selected annotation after the overlapping committed mutation save fails', async () => {
    const project = createProject(audio);
    project.annotations.push({
      ...project.draft,
      id: 'saved-annotation',
      startMs: 40,
      endMs: 80,
      transcription: 'recover selection',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    });
    const failedSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => failedSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(project);

    const mutation = store.mutateProject((value) => ({ ...value, displayFormat: 'clock' }));
    store.selectAnnotation('saved-annotation');
    await vi.advanceTimersByTimeAsync(300);
    failedSave.reject(new Error('disk full'));

    await expect(mutation).resolves.toBe(false);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      displayFormat: 'seconds',
      activeAnnotationId: 'saved-annotation',
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({ transcription: 'recover selection' })
    }));
  });

  it('merges an unrelated newer draft field without restoring a reference removed by the committed mutation', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    const originalSpeaker = get(store).project!.speakers[0];
    const replacementSpeaker = get(store).project!.speakers[1];

    const mutation = store.mutateProject((project) => ({
      ...project,
      speakers: project.speakers.filter((speaker) => speaker.id !== originalSpeaker.id),
      draft: { ...project.draft, speakerId: replacementSpeaker.id }
    }));
    store.patchDraft({ notes: 'typed while removing a speaker' });
    mutationSave.resolve();

    await expect(mutation).resolves.toBe(true);
    expect(get(store).project).toMatchObject({
      draft: { speakerId: replacementSpeaker.id, notes: 'typed while removing a speaker' }
    });
    expect(get(store).project!.speakers.map((speaker) => speaker.id)).not.toContain(originalSpeaker.id);
  });

  it('keeps newer draft edits after a committed mutation save fails and includes them in recovery', async () => {
    const failedSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => failedSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    const failedMutation = store.mutateProject((project) => ({ ...project, displayFormat: 'clock' }));
    store.patchDraft({ notes: 'recover after failure' });
    failedSave.reject(new Error('disk full'));

    await expect(failedMutation).resolves.toBe(false);
    expect(get(store).project).toMatchObject({
      displayFormat: 'seconds',
      draft: { notes: 'recover after failure' }
    });

    await expect(store.mutateProject((project) => ({
      ...project,
      exportSettings: { multilinePolicy: 'quoted' }
    }))).resolves.toBe(true);
    expect(get(store).project).toMatchObject({
      displayFormat: 'seconds',
      draft: { notes: 'recover after failure' },
      exportSettings: { multilinePolicy: 'quoted' }
    });
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ notes: 'recover after failure' }),
      exportSettings: { multilinePolicy: 'quoted' }
    }));
  });

  it('waits for an already-started committed mutation before flushing its published project', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    const mutation = store.mutateProject((project) => ({
      ...project,
      draft: { ...project.draft, notes: 'committed before transition' }
    }));
    const flush = store.flush();
    let flushSettled = false;
    void flush.then(() => { flushSettled = true; });
    await Promise.resolve();

    expect(flushSettled).toBe(false);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await expect(flush).resolves.toBe(true);
    expect(get(store).project!.draft.notes).toBe('committed before transition');
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ notes: 'committed before transition' })
    }));
  });

  it('retains failed-save evidence if a caller opens another project', async () => {
    bridge.saveProject.mockRejectedValueOnce(new Error('old project is not writable'));
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'unsaved old draft' });
    await expect(store.flush()).resolves.toBe(false);

    store.open(createProject({ ...audio, canonicalPath: 'b.wav' }));

    expect(get(store).saveError).toBe('Error: old project is not writable');
  });
});
