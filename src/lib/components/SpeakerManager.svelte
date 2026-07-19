<script lang="ts">
  import { addLabel, removeSpeaker, renameSpeaker } from '../domain/project';
  import type { ProjectStore } from '../state/projectStore';

  export let store: ProjectStore;
  export let disabled = false;

  let nextLabel = '';
  let replacements: Record<string, string> = {};

  async function add(): Promise<void> {
    if (await store.mutateProject((project) => addLabel(project, 'speakers', nextLabel))) nextLabel = '';
  }

  async function rename(id: string, value: string): Promise<void> {
    await store.mutateProject((project) => renameSpeaker(project, id, value));
  }

  async function remove(id: string): Promise<void> {
    const project = $store.project;
    if (!project) return;
    const referenced = project.annotations.some((annotation) => annotation.speakerId === id)
      || project.draft.speakerId === id;
    const reassignTo = referenced ? replacements[id] : undefined;
    if (referenced && !reassignTo) return;
    await store.mutateProject((value) => removeSpeaker(value, id, reassignTo));
  }
</script>

{#if $store.project}
  {@const project = $store.project}
  <section class="label-manager" aria-label="Speaker manager">
    <h4>Speakers</h4>
    {#each project.speakers as speaker (speaker.id)}
      {@const referenced = project.annotations.some((annotation) => annotation.speakerId === speaker.id) || project.draft.speakerId === speaker.id}
      <div class="label-row">
        <label>
          <span>Name</span>
          <input
            aria-label={`Rename ${speaker.label}`}
            value={speaker.label}
            {disabled}
            on:blur={(event) => rename(speaker.id, (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {#if referenced}
          <label>
            <span>Reassign to</span>
            <select
              aria-label={`Reassign ${speaker.label}`}
              value={replacements[speaker.id] ?? ''}
              {disabled}
              on:change={(event) => replacements = { ...replacements, [speaker.id]: (event.currentTarget as HTMLSelectElement).value }}
            >
              <option value="">Choose replacement</option>
              {#each project.speakers.filter((item) => item.id !== speaker.id) as alternative (alternative.id)}
                <option value={alternative.id}>{alternative.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        <button type="button" disabled={disabled || (referenced && !replacements[speaker.id])} on:click={() => remove(speaker.id)}>
          Remove {speaker.label}
        </button>
      </div>
    {/each}

    <label>
      <span>New speaker</span>
      <input aria-label="New speaker" bind:value={nextLabel} {disabled} />
    </label>
    <button type="button" {disabled} on:click={add}>Add speaker</button>
  </section>
{/if}
