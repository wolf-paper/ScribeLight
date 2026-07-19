<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import { normalizeDraftForEventType } from '../domain/validation';
  import { formatTime } from '../domain/time';
  import type { EventType } from '../domain/types';
  import AcousticTagManager from './AcousticTagManager.svelte';
  import SpeakerManager from './SpeakerManager.svelte';

  export let store: ProjectStore;
  export let disabled = false;

  const submit = () => { if (!disabled) void store.commitDraft(); };

  function onEditorKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }

  function eventTypeChanged(event: Event) {
    if (disabled) return;
    const project = $store.project;
    if (!project) return;
    const eventType = (event.currentTarget as HTMLSelectElement).value as EventType;
    store.patchDraft(normalizeDraftForEventType(project.draft, eventType));
  }

  function setTag(tagId: string, checked: boolean) {
    if (disabled) return;
    const project = $store.project;
    if (!project) return;
    const acousticTagIds = checked
      ? [...project.draft.acousticTagIds, tagId]
      : project.draft.acousticTagIds.filter((id) => id !== tagId);
    store.patchDraft({ acousticTagIds });
  }

  function boundaryChanged(field: 'startMs' | 'endMs', input: HTMLInputElement) {
    const rawValue = input.value.trim();
    if (!rawValue) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || !Number.isInteger(value)) return;
    store.patchBoundaries(field === 'startMs' ? { startMs: value } : { endMs: value });
  }
</script>

{#if $store.project}
  {@const project = $store.project}
  <section class="annotation-dashboard" aria-label="Annotation dashboard">
    <fieldset disabled={disabled} aria-label="Annotation editor controls">
    <div class="boundary-grid">
      <label>
        Start
        <output aria-label="Loop start time">{formatTime(project.draft.startMs, project.displayFormat)}</output>
        <input
          aria-label="Start milliseconds"
          type="number"
          min="0"
          max={project.audioIdentity.durationMs}
          step="1"
          value={project.draft.startMs}
          aria-describedby="boundary-editing-help"
          on:input={(event) => boundaryChanged('startMs', event.currentTarget as HTMLInputElement)}
        />
      </label>
      <label>
        End
        <output aria-label="Loop end time">{formatTime(project.draft.endMs, project.displayFormat)}</output>
        <input
          aria-label="End milliseconds"
          type="number"
          min="1"
          max={project.audioIdentity.durationMs}
          step="1"
          value={project.draft.endMs}
          aria-describedby="boundary-editing-help"
          on:input={(event) => boundaryChanged('endMs', event.currentTarget as HTMLInputElement)}
        />
      </label>
    </div>
    <p id="boundary-editing-help">Edit either value freely; the loop updates when both boundaries form a valid range.</p>

    <label>
      Event type
      <select aria-label="Event type" value={project.draft.eventType} on:change={eventTypeChanged}>
        <option value="speech">speech</option>
        <option value="non_speech">non_speech</option>
      </select>
    </label>

    <label>
      Speaker
      <select
        aria-label="Speaker"
        disabled={project.draft.eventType === 'non_speech'}
        value={project.draft.speakerId ?? ''}
        on:change={(event) => store.patchDraft({ speakerId: (event.currentTarget as HTMLSelectElement).value || null })}
      >
        {#if project.draft.eventType === 'non_speech'}
          <option value="">none</option>
        {/if}
        {#each project.speakers as speaker}
          <option value={speaker.id}>{speaker.label}</option>
        {/each}
      </select>
    </label>
    <SpeakerManager {store} />

    <label>
      Transcription
      <textarea
        aria-label="Transcription"
        rows="5"
        value={project.draft.transcription}
        on:input={(event) => store.patchDraft({ transcription: (event.currentTarget as HTMLTextAreaElement).value })}
        on:keydown={onEditorKeydown}
      ></textarea>
    </label>

    <div class="metadata-grid">
      <label>
        Intelligibility
        <select aria-label="Intelligibility" value={project.draft.intelligibility} on:change={(event) => store.patchDraft({ intelligibility: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.intelligibility })}>
          <option>intelligible</option>
          <option>partially_intelligible</option>
          <option>unintelligible</option>
          <option>not_applicable</option>
        </select>
      </label>
      <label>
        Overlap
        <select aria-label="Overlap" value={project.draft.overlap} on:change={(event) => store.patchDraft({ overlap: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.overlap })}>
          <option>none</option>
          <option>overlap</option>
        </select>
      </label>
      <label>
        Confidence
        <select aria-label="Confidence" value={project.draft.confidence} on:change={(event) => store.patchDraft({ confidence: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.confidence })}>
          <option>high</option>
          <option>medium</option>
          <option>low</option>
        </select>
      </label>
    </div>

    <fieldset>
      <legend>Acoustic tags</legend>
      {#each project.acousticTags as tag}
        <label>
          <input
            aria-label={tag.label}
            type="checkbox"
            checked={project.draft.acousticTagIds.includes(tag.id)}
            on:change={(event) => setTag(tag.id, (event.currentTarget as HTMLInputElement).checked)}
          />
          {tag.label}
        </label>
      {/each}
    </fieldset>
    <AcousticTagManager {store} />

    <label>
      Notes
      <textarea
        aria-label="Notes"
        rows="3"
        value={project.draft.notes}
        on:input={(event) => store.patchDraft({ notes: (event.currentTarget as HTMLTextAreaElement).value })}
        on:keydown={onEditorKeydown}
      ></textarea>
    </label>

    {#if Object.keys($store.errors).length}
      <div role="alert">Correct the highlighted annotation fields.</div>
    {/if}

    <div class="actions">
      <button type="button" on:click={submit}>{project.activeAnnotationId ? 'Update annotation' : 'Add annotation'}</button>
      <button type="button" on:click={() => store.clearDraft()}>Clear</button>
    </div>
    </fieldset>
  </section>
{/if}
