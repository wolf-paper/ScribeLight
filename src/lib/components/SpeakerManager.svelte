<script lang="ts">
  import { addLabel, removeSpeaker, renameSpeaker } from '../domain/project';
  import type { ProjectStore } from '../state/projectStore';

  export let store: ProjectStore;

  let nextLabel = '';
  let replacements: Record<string, string> = {};

  async function add(): Promise<void> {
    if (await store.mutateProject((project) => addLabel(project, 'speakers', nextLabel))) {
      nextLabel = '';
    }
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
  <section aria-label="Speaker manager">
    {#each project.speakers as speaker (speaker.id)}
      {@const referenced = project.annotations.some((annotation) => annotation.speakerId === speaker.id) || project.draft.speakerId === speaker.id}
      <div>
        <input
          aria-label={`Rename ${speaker.label}`}
          value={speaker.label}
          on:blur={(event) => rename(speaker.id, (event.currentTarget as HTMLInputElement).value)}
        />
        {#if referenced}
          <select
            aria-label={`Reassign ${speaker.label}`}
            value={replacements[speaker.id] ?? ''}
            on:change={(event) => replacements = { ...replacements, [speaker.id]: (event.currentTarget as HTMLSelectElement).value }}
          >
            <option value="">Choose replacement</option>
            {#each project.speakers.filter((item) => item.id !== speaker.id) as alternative (alternative.id)}
              <option value={alternative.id}>{alternative.label}</option>
            {/each}
          </select>
        {/if}
        <button type="button" disabled={referenced && !replacements[speaker.id]} on:click={() => remove(speaker.id)}>
          Remove {speaker.label}
        </button>
      </div>
    {/each}

    <label>
      New speaker
      <input aria-label="New speaker" bind:value={nextLabel} />
    </label>
    <button type="button" on:click={add}>Add speaker</button>

    {#if $store.saveError}
      <p role="alert">{$store.saveError}</p>
    {/if}
  </section>
{/if}
