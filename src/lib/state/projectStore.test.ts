import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, emptyDraft, removeSpeaker, removeTag } from '../domain/project';
import type { Annotation, AnnotationDraft, Project } from '../domain/types';
import { worksheetErrors } from '../domain/validation';
import { ProjectStore } from './projectStore';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };
const created = '2026-01-01T00:00:00Z';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function clock(): () => string {
  let tick = 0;
  return () => `2026-02-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

/** A project holding `saved-annotation` (40–80 ms); when active, the editor shows it. */
function projectWithAnnotation(active: boolean): Project {
  const project = createProject(audio);
  project.annotations.push({
    ...project.draft,
    id: 'saved-annotation',
    startMs: 40,
    endMs: 80,
    transcription: 'saved text',
    createdAt: created,
    updatedAt: created
  });
  if (active) {
    project.activeAnnotationId = 'saved-annotation';
    project.activeSelection = { startMs: 40, endMs: 80 };
    project.draft = { ...project.draft, startMs: 40, endMs: 80, transcription: 'saved text' };
  }
  return project;
}

const renameFirstSpeaker = (project: Project): Project => ({
  ...project,
  speakers: project.speakers.map((speaker, index) => index === 0 ? { ...speaker, label: 'speaker_9' } : speaker)
});

describe('ProjectStore', () => {
  const bridge = { saveProject: vi.fn<(project: Project) => Promise<void>>(async () => undefined) };

  beforeEach(() => {
    bridge.saveProject.mockReset();
    bridge.saveProject.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('adds a draft and autosaves later edits into the same annotation identity', async () => {
    const store = new ProjectStore(bridge, () => 'event-1', clock());
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'one' });
    await expect(store.addDraft()).resolves.toBe(true);
    store.patchDraft({ transcription: 'two' });

    expect(get(store).project).toMatchObject({
      activeAnnotationId: 'event-1',
      annotations: [{
        id: 'event-1',
        transcription: 'two',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:01.000Z'
      }]
    });
    vi.advanceTimersByTime(350);
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [expect.objectContaining({ id: 'event-1', transcription: 'two' })]
    }));
  });

  it('refuses to add a structurally invalid draft, keeps it recoverable, and clears its errors on the next edit', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ startMs: 20, endMs: 10 });

    await expect(store.addDraft()).resolves.toBe(false);
    expect(get(store).errors).toMatchObject({ endMs: 'End must be later than start' });
    expect(get(store).project!.annotations).toEqual([]);
    expect(bridge.saveProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledOnce();
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [],
      draft: expect.objectContaining({ startMs: 20, endMs: 10 })
    }));

    store.patchDraft({ endMs: 30 });
    expect(get(store).errors).toEqual({});
  });

  it('refuses to add while an annotation is active', async () => {
    const store = new ProjectStore(bridge, () => 'event-2');
    store.open(projectWithAnnotation(true));

    await expect(store.addDraft()).resolves.toBe(false);
    expect(get(store).project!.annotations.map(({ id }) => id)).toEqual(['saved-annotation']);
    expect(get(store).errors).toEqual({});
    expect(bridge.saveProject).not.toHaveBeenCalled();
  });

  it('stores drafts and edits that still break Yamabiko worksheet rules', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.setSelection({ startMs: 10, endMs: 20 });
    expect(worksheetErrors(get(store).project!.draft, get(store).project!)).toHaveProperty('transcription');

    await expect(store.addDraft()).resolves.toBe(true);
    store.patchDraft({ transcription: 'words' });
    store.patchDraft({ transcription: '' });

    const project = get(store).project!;
    expect(project.annotations).toEqual([expect.objectContaining({ id: 'event-1', transcription: '' })]);
    expect(worksheetErrors(project.annotations[0], project)).toHaveProperty('transcription');
    expect(get(store).errors).toEqual({});
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

  it('serializes a recovery write before the later add snapshot', async () => {
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

    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'added snapshot' });
    const add = store.addDraft();
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    recovery.resolve();
    await add;

    expect(saved).toHaveLength(2);
    expect(saved[1].annotations).toMatchObject([{ id: 'event-1', transcription: 'added snapshot' }]);
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
      saveError: 'disk full'
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

  it('updates a valid dashboard boundary pair in the draft and active selection together', () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.setSelection({ startMs: 10, endMs: 20 });

    store.patchBoundaries({ startMs: 12 });
    store.patchBoundaries({ endMs: 34 });

    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 12, endMs: 34 },
      draft: { startMs: 12, endMs: 34 }
    });
  });

  it('keeps the last valid selection while dashboard fields temporarily form an invalid range', () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.setSelection({ startMs: 0, endMs: 100 });

    store.patchBoundaries({ startMs: 300 });
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 0, endMs: 100 },
      draft: { startMs: 300, endMs: 100 }
    });

    store.patchBoundaries({ endMs: 400 });
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 300, endMs: 400 },
      draft: { startMs: 300, endMs: 400 }
    });
  });

  it('does not propagate fractional or out-of-bounds dashboard boundaries', () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.setSelection({ startMs: 10, endMs: 20 });

    store.patchBoundaries({ startMs: 10.5 });
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10.5, endMs: 20 }
    });
    store.patchBoundaries({ startMs: 10, endMs: 1_001 });
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10, endMs: 1_001 }
    });
  });

  it('adds and autosaves boundaries as one coherent active editor state', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.patchBoundaries({ startMs: 10, endMs: 20 });
    store.patchDraft({ transcription: 'first' });

    await expect(store.addDraft()).resolves.toBe(true);
    expect(get(store).project).toMatchObject({
      activeAnnotationId: 'event-1',
      activeSelection: { startMs: 10, endMs: 20 },
      draft: { startMs: 10, endMs: 20 },
      annotations: [expect.objectContaining({ id: 'event-1', startMs: 10, endMs: 20 })]
    });

    store.patchBoundaries({ startMs: 30 });
    expect(get(store)).toMatchObject({
      project: { annotations: [expect.objectContaining({ startMs: 10, endMs: 20 })] },
      errors: { endMs: 'End must be later than start' }
    });
    store.patchBoundaries({ endMs: 40 });
    expect(get(store).project).toMatchObject({
      activeAnnotationId: 'event-1',
      activeSelection: { startMs: 30, endMs: 40 },
      draft: { startMs: 30, endMs: 40 },
      annotations: [expect.objectContaining({ id: 'event-1', startMs: 30, endMs: 40 })]
    });
    expect(get(store).errors).toEqual({});
  });

  const fieldEdits: [string, (project: Project) => Partial<AnnotationDraft>][] = [
    ['range', () => ({ startMs: 30, endMs: 90 })],
    ['event type', () => ({ eventType: 'non_speech' })],
    ['transcription', () => ({ transcription: 'edited words' })],
    ['intelligibility', () => ({ intelligibility: 'unintelligible' })],
    ['speaker', (project) => ({ speakerId: project.speakers[1].id })],
    ['overlap', () => ({ overlap: 'overlap' })],
    ['confidence', () => ({ confidence: 'low' })],
    ['acoustic tag', (project) => ({ acousticTagIds: [project.acousticTags[2].id] })],
    ['notes', () => ({ notes: 'edited note' })]
  ];

  it.each(fieldEdits)('autosaves a %s edit into the active annotation', async (_field, edit) => {
    const project = projectWithAnnotation(true);
    const patch = edit(project);
    const store = new ProjectStore(bridge, undefined, clock());
    store.open(project);

    store.patchDraft(patch);

    const expected = {
      ...patch,
      id: 'saved-annotation',
      createdAt: created,
      updatedAt: '2026-02-01T00:00:00.000Z'
    };
    expect(get(store)).toMatchObject({
      project: { activeAnnotationId: 'saved-annotation', annotations: [expected] },
      errors: {}
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledOnce();
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [expect.objectContaining(expected)]
    }));
  });

  it('autosaves timeline and boundary-field range edits into the active annotation', () => {
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(true));

    store.setSelection({ startMs: 100, endMs: 200 });
    expect(get(store).project!.annotations[0]).toMatchObject({ startMs: 100, endMs: 200 });

    store.patchBoundaries({ endMs: 300 });
    expect(get(store).project).toMatchObject({
      activeSelection: { startMs: 100, endMs: 300 },
      annotations: [expect.objectContaining({ id: 'saved-annotation', startMs: 100, endMs: 300 })]
    });
  });

  it('keeps a structurally invalid edit out of the annotation until it is fixed', () => {
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(true));

    store.patchBoundaries({ startMs: 300 });
    store.patchDraft({ transcription: 'tab\there' });
    expect(get(store)).toMatchObject({
      project: {
        activeSelection: { startMs: 40, endMs: 80 },
        annotations: [expect.objectContaining({ startMs: 40, endMs: 80, transcription: 'saved text' })]
      },
      errors: { endMs: 'End must be later than start', transcription: 'Transcription cannot contain tabs' }
    });

    store.patchBoundaries({ endMs: 400 });
    expect(get(store).errors).toEqual({ transcription: 'Transcription cannot contain tabs' });
    expect(get(store).project!.annotations[0]).toMatchObject({ startMs: 40, endMs: 80 });

    store.patchDraft({ transcription: 'fixed' });
    expect(get(store).errors).toEqual({});
    expect(get(store).project!.annotations[0]).toMatchObject({ startMs: 300, endMs: 400, transcription: 'fixed' });
  });

  it('leaves the active annotation untouched when an edit changes nothing', () => {
    const store = new ProjectStore(bridge, undefined, clock());
    store.open(projectWithAnnotation(true));
    const before = get(store).project!.annotations[0];

    store.patchDraft({ transcription: 'saved text' });
    store.setSelection({ startMs: 40, endMs: 80 });

    expect(get(store).project!.annotations[0]).toBe(before);
  });

  it('keeps an autosaved edit typed while a label rename save is unresolved', async () => {
    const renameSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => renameSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge, undefined, clock());
    store.open(projectWithAnnotation(true));

    const rename = store.mutateProject(renameFirstSpeaker);
    store.patchDraft({ transcription: 'typed during rename' });
    const autosaved = get(store).project!.annotations[0];
    expect(autosaved.transcription).toBe('typed during rename');
    expect(bridge.saveProject.mock.calls[0][0].annotations[0].transcription).toBe('saved text');

    renameSave.resolve();
    await expect(rename).resolves.toBe(true);

    expect(get(store).project).toMatchObject({
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      activeAnnotationId: 'saved-annotation',
      draft: { transcription: 'typed during rename' },
      annotations: [{ ...autosaved }]
    });
    await vi.runAllTimersAsync();
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      annotations: [expect.objectContaining({ id: 'saved-annotation', transcription: 'typed during rename' })]
    }));
  });

  it('keeps draft edits typed while adding it is unresolved', async () => {
    const addSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => addSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.setSelection({ startMs: 10, endMs: 20 });
    store.patchDraft({ transcription: 'first' });

    const adding = store.addDraft();
    store.patchDraft({ transcription: 'first words' });
    addSave.resolve();
    await expect(adding).resolves.toBe(true);

    expect(get(store).project).toMatchObject({
      activeAnnotationId: 'event-1',
      draft: { transcription: 'first words' },
      annotations: [expect.objectContaining({ id: 'event-1', transcription: 'first words' })]
    });
    await vi.runAllTimersAsync();
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [expect.objectContaining({ id: 'event-1', transcription: 'first words' })]
    }));
  });

  it('still writes recovery for autosaved edits when a later mutation stores nothing', async () => {
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(true));
    store.patchDraft({ transcription: 'autosaved' });

    await expect(store.mutateProject(() => { throw new Error('Label must be unique'); })).resolves.toBe(false);
    expect(bridge.saveProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledOnce();
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [expect.objectContaining({ transcription: 'autosaved' })]
    }));
  });

  it('restores a selected annotation into the editor and selection', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    const speakerId = get(store).project!.speakers[1].id;
    const acousticTagId = get(store).project!.acousticTags.find((tag) => tag.label === 'overlap')!.id;
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
    await store.addDraft();
    store.beginDraft(null);
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
    expect(get(store).errors).toEqual({});
  });

  it('begins a new draft over a selection after autosaving the active annotation', async () => {
    const project = projectWithAnnotation(false);
    const store = new ProjectStore(bridge);
    store.open(project);
    store.selectAnnotation('saved-annotation');
    store.patchDraft({
      transcription: 'autosaved edit',
      intelligibility: 'unintelligible',
      speakerId: project.speakers[1].id,
      overlap: 'overlap',
      confidence: 'low',
      acousticTagIds: [project.acousticTags[0].id],
      notes: 'kept metadata'
    });
    await vi.advanceTimersByTimeAsync(300);
    bridge.saveProject.mockClear();

    store.beginDraft({ startMs: 500, endMs: 600 });

    expect(get(store)).toMatchObject({
      project: {
        annotations: [expect.objectContaining({
          id: 'saved-annotation',
          startMs: 40,
          endMs: 80,
          transcription: 'autosaved edit',
          notes: 'kept metadata'
        })],
        activeAnnotationId: null,
        activeSelection: { startMs: 500, endMs: 600 },
        draft: { ...emptyDraft(), startMs: 500, endMs: 600, speakerId: project.speakers[0].id }
      },
      errors: {}
    });
    expect(bridge.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      activeAnnotationId: null,
      activeSelection: { startMs: 500, endMs: 600 }
    }));
  });

  it('begins an empty draft without a selection and drops unsaved invalid edits', () => {
    const project = projectWithAnnotation(true);
    const store = new ProjectStore(bridge);
    store.open(project);
    store.patchBoundaries({ startMs: 300 });
    expect(get(store).errors).toHaveProperty('endMs');

    store.beginDraft(null);

    expect(get(store)).toMatchObject({
      project: {
        annotations: [expect.objectContaining({ id: 'saved-annotation', startMs: 40, endMs: 80 })],
        activeAnnotationId: null,
        activeSelection: null,
        draft: { ...emptyDraft(), speakerId: project.speakers[0].id }
      },
      errors: {}
    });
  });

  it('removes the active annotation, clears it from the editor, and returns it', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'remove me' });
    await store.addDraft();
    const added = get(store).project!.annotations[0];

    await expect(store.removeAnnotation('event-1')).resolves.toEqual(added);
    expect(get(store).project).toMatchObject({
      annotations: [],
      activeAnnotationId: null,
      activeSelection: null,
      draft: { ...emptyDraft(), speakerId: get(store).project!.speakers[0].id }
    });
    await expect(store.removeAnnotation('event-1')).resolves.toBeNull();
  });

  it('restores a removed annotation for undo without changing the active annotation', async () => {
    const project = projectWithAnnotation(true);
    const other: Annotation = { ...project.annotations[0], id: 'other', startMs: 200, endMs: 300, transcription: 'other text' };
    project.annotations.push(other);
    const store = new ProjectStore(bridge);
    store.open(project);

    const removed = await store.removeAnnotation('other');
    expect(removed).toEqual(other);
    expect(get(store).project!.annotations.map(({ id }) => id)).toEqual(['saved-annotation']);
    store.patchDraft({ notes: 'editing while removed' });

    await expect(store.restoreAnnotation(removed!)).resolves.toBe(true);
    expect(get(store).project).toMatchObject({
      annotations: [expect.objectContaining({ id: 'saved-annotation', notes: 'editing while removed' }), other],
      activeAnnotationId: 'saved-annotation',
      activeSelection: { startMs: 40, endMs: 80 },
      draft: { notes: 'editing while removed' }
    });
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      annotations: [expect.objectContaining({ id: 'saved-annotation' }), other]
    }));

    await expect(store.restoreAnnotation(removed!)).resolves.toBe(false);
    expect(get(store).project!.annotations).toHaveLength(2);
  });

  it('refuses to restore an annotation whose speaker no longer exists', async () => {
    const project = projectWithAnnotation(false);
    project.annotations[0].speakerId = project.speakers[2].id;
    const store = new ProjectStore(bridge);
    store.open(project);

    const removed = await store.removeAnnotation('saved-annotation');
    await expect(store.mutateProject((value) => removeSpeaker(value, project.speakers[2].id))).resolves.toBe(true);

    await expect(store.restoreAnnotation(removed!)).resolves.toBe(false);
    expect(get(store).project!.annotations).toEqual([]);
  });

  it('keeps local project state and exposes a save failure', async () => {
    bridge.saveProject.mockRejectedValueOnce({ kind: 'persistence', message: 'disk full' });
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'do not lose me' });

    await expect(store.flush()).resolves.toBe(false);

    expect(get(store)).toMatchObject({
      project: { draft: { notes: 'do not lose me' } },
      saveError: 'disk full'
    });
  });

  it('does not publish a committed mutation when its atomic save fails', async () => {
    bridge.saveProject.mockRejectedValueOnce({ kind: 'persistence', message: 'disk full' });
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));

    await expect(store.mutateProject(renameFirstSpeaker)).resolves.toBe(false);

    expect(get(store).project!.speakers[0].label).toBe('speaker_1');
    expect(get(store).saveError).toBe('disk full');
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

    const mutation = store.mutateProject(renameFirstSpeaker);
    store.patchDraft({ notes: 'typed while saving' });
    store.setSelection({ startMs: 12, endMs: 34 });
    await vi.advanceTimersByTimeAsync(300);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    const expected = {
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      activeSelection: { startMs: 12, endMs: 34 },
      draft: expect.objectContaining({ startMs: 12, endMs: 34, notes: 'typed while saving' })
    };
    expect(get(store).project).toMatchObject(expected);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining(expected));
  });

  it('persists a selected annotation merged while a committed mutation save is unresolved', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(false));

    const mutation = store.mutateProject(renameFirstSpeaker);
    store.selectAnnotation('saved-annotation');
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      activeAnnotationId: 'saved-annotation',
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({
        startMs: 40,
        endMs: 80,
        transcription: 'saved text'
      })
    }));
  });

  it('persists a draft begun without a selection while a committed mutation save is unresolved', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(true));

    const mutation = store.mutateProject(renameFirstSpeaker);
    store.beginDraft(null);
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      annotations: [expect.objectContaining({ id: 'saved-annotation', transcription: 'saved text' })],
      activeAnnotationId: null,
      activeSelection: null,
      draft: expect.objectContaining({ startMs: 0, endMs: 0, transcription: '' })
    }));
  });

  it('persists a draft begun over a selection while a committed mutation save is unresolved', async () => {
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(false));
    store.selectAnnotation('saved-annotation');

    const mutation = store.mutateProject(renameFirstSpeaker);
    store.beginDraft({ startMs: 40, endMs: 80 });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);

    mutationSave.resolve();
    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_9' })]),
      annotations: [expect.objectContaining({ id: 'saved-annotation', transcription: 'saved text' })],
      activeAnnotationId: null,
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({ startMs: 40, endMs: 80, transcription: '', notes: '' })
    }));
  });

  it('preserves a draft begun while removing the active annotation is unresolved', async () => {
    const project = projectWithAnnotation(true);
    const removalSave = deferred<void>();
    const savedProjects: Project[] = [];
    bridge.saveProject.mockImplementation((candidate) => {
      savedProjects.push(structuredClone(candidate));
      return savedProjects.length === 1 ? removalSave.promise : Promise.resolve();
    });
    const store = new ProjectStore(bridge);
    store.open(project);

    const removal = store.removeAnnotation('saved-annotation');
    expect(bridge.saveProject).toHaveBeenCalledOnce();
    expect(savedProjects[0]).toMatchObject({
      annotations: [],
      activeAnnotationId: null,
      activeSelection: null
    });
    store.beginDraft({ startMs: 40, endMs: 80 });
    expect(get(store).project).toMatchObject({
      activeAnnotationId: null,
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({ startMs: 40, endMs: 80, transcription: '' })
    });

    removalSave.resolve();
    await expect(removal).resolves.toMatchObject({ id: 'saved-annotation' });
    await vi.runAllTimersAsync();

    const expectedEditor = {
      annotations: [],
      activeAnnotationId: null,
      activeSelection: { startMs: 40, endMs: 80 },
      draft: { ...emptyDraft(), startMs: 40, endMs: 80, speakerId: project.speakers[0].id }
    };
    expect(get(store).project).toMatchObject(expectedEditor);
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(savedProjects.at(-1)).toMatchObject(expectedEditor);
  });

  it('recovers a selected annotation after the overlapping committed mutation save fails', async () => {
    const failedSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => failedSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(projectWithAnnotation(false));

    const mutation = store.mutateProject(renameFirstSpeaker);
    store.selectAnnotation('saved-annotation');
    await vi.advanceTimersByTimeAsync(300);
    failedSave.reject(new Error('disk full'));

    await expect(mutation).resolves.toBe(false);
    await vi.runAllTimersAsync();

    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    const recovered = bridge.saveProject.mock.lastCall![0];
    expect(recovered.speakers[0].label).toBe('speaker_1');
    expect(recovered).toMatchObject({
      activeAnnotationId: 'saved-annotation',
      activeSelection: { startMs: 40, endMs: 80 },
      draft: expect.objectContaining({ transcription: 'saved text' })
    });
  });

  it('rebuilds a concurrently selected surviving annotation from the committed candidate', async () => {
    const project = createProject(audio);
    const speakerA = project.speakers[0];
    const speakerB = project.speakers[1];
    const speakerC = project.speakers[2];
    const removedTag = project.acousticTags[0];
    const survivingTag = project.acousticTags[1];
    project.draft = {
      ...project.draft,
      startMs: 10,
      endMs: 20,
      speakerId: speakerB.id,
      transcription: 'unrelated draft using B',
      acousticTagIds: [survivingTag.id]
    };
    project.activeSelection = { startMs: 10, endMs: 20 };
    project.annotations.push({
      ...project.draft,
      id: 'annotation-x',
      startMs: 40,
      endMs: 80,
      speakerId: speakerA.id,
      transcription: 'candidate annotation X',
      acousticTagIds: [removedTag.id, survivingTag.id],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    });
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(project);

    const mutation = store.mutateProject((current) => {
      const reassigned = removeSpeaker(current, speakerA.id, speakerC.id);
      const withoutTag = removeTag(reassigned, removedTag.id, true);
      return {
        ...withoutTag,
        annotations: withoutTag.annotations.map((annotation) => annotation.id === 'annotation-x'
          ? { ...annotation, startMs: 50, endMs: 90 }
          : annotation)
      };
    });
    store.selectAnnotation('annotation-x');
    store.patchDraft({ transcription: 'latest transcription edit', notes: 'latest note edit' });
    await vi.advanceTimersByTimeAsync(300);
    mutationSave.resolve();

    await expect(mutation).resolves.toBe(true);
    await vi.runAllTimersAsync();

    const merged = {
      startMs: 50,
      endMs: 90,
      speakerId: speakerC.id,
      acousticTagIds: [survivingTag.id],
      transcription: 'latest transcription edit',
      notes: 'latest note edit'
    };
    const expectedEditor = {
      activeAnnotationId: 'annotation-x',
      activeSelection: { startMs: 50, endMs: 90 },
      draft: expect.objectContaining(merged),
      annotations: [expect.objectContaining({ id: 'annotation-x', ...merged })]
    };
    expect(get(store).project).toMatchObject(expectedEditor);
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining(expectedEditor));
  });

  it('rejects a concurrently selected annotation deleted by the committed candidate', async () => {
    const project = projectWithAnnotation(true);
    const mutationSave = deferred<void>();
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const store = new ProjectStore(bridge);
    store.open(project);

    const removal = store.removeAnnotation('saved-annotation');
    store.selectAnnotation('saved-annotation');
    store.patchDraft({ notes: 'independent note after selection' });
    await vi.advanceTimersByTimeAsync(300);
    mutationSave.resolve();

    await removal;
    await vi.runAllTimersAsync();

    const expectedClearedEditor = {
      annotations: [],
      activeAnnotationId: null,
      activeSelection: null,
      draft: expect.objectContaining({
        startMs: 0,
        endMs: 0,
        transcription: '',
        speakerId: project.speakers[0].id,
        acousticTagIds: [],
        notes: 'independent note after selection'
      })
    };
    expect(get(store).project).toMatchObject(expectedClearedEditor);
    expect(bridge.saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining(expectedClearedEditor));
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

    const failedMutation = store.mutateProject(renameFirstSpeaker);
    store.patchDraft({ notes: 'recover after failure' });
    failedSave.reject(new Error('disk full'));

    await expect(failedMutation).resolves.toBe(false);
    expect(get(store).project!.speakers[0].label).toBe('speaker_1');
    expect(get(store).project!.draft.notes).toBe('recover after failure');

    await expect(store.mutateProject((project) => ({
      ...project,
      speakers: project.speakers.map((speaker, index) => index === 1 ? { ...speaker, label: 'speaker_8' } : speaker)
    }))).resolves.toBe(true);
    expect(get(store).project!.speakers.map(({ label }) => label)).toEqual(['speaker_1', 'speaker_8', 'speaker_3']);
    expect(get(store).project!.draft.notes).toBe('recover after failure');
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ notes: 'recover after failure' }),
      speakers: expect.arrayContaining([expect.objectContaining({ label: 'speaker_8' })])
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
    bridge.saveProject.mockRejectedValueOnce({ kind: 'persistence', message: 'old project is not writable' });
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'unsaved old draft' });
    await expect(store.flush()).resolves.toBe(false);

    store.open(createProject({ ...audio, canonicalPath: 'b.wav' }));

    expect(get(store).saveError).toBe('old project is not writable');
  });
});
