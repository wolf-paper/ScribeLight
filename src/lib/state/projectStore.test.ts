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
    await store.flush();

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
    await store.flush();
    store.patchDraft({ notes: 'later save' });
    await store.flush();

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

    await store.flush();

    expect(get(store)).toMatchObject({
      project: { draft: { notes: 'do not lose me' } },
      saveError: 'Error: disk full'
    });
  });
});
