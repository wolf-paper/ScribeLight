<script lang="ts">
  import { addLabel, removeTag, renameTag } from '../domain/project';
  import type { ProjectStore } from '../state/projectStore';

  export let store: ProjectStore;

  let nextLabel = '';

  async function add(): Promise<void> {
    if (await store.mutateProject((project) => addLabel(project, 'acousticTags', nextLabel))) {
      nextLabel = '';
    }
  }

  async function rename(id: string, value: string): Promise<void> {
    await store.mutateProject((project) => renameTag(project, id, value));
  }

  async function remove(id: string): Promise<void> {
    const project = $store.project;
    if (!project) return;
    const referenced = project.annotations.some((annotation) => annotation.acousticTagIds.includes(id))
      || project.draft.acousticTagIds.includes(id);
    if (referenced && !window.confirm('Remove this tag from every affected annotation?')) return;
    await store.mutateProject((value) => removeTag(value, id, true));
  }
</script>

{#if $store.project}
  {@const project = $store.project}
  <section aria-label="Acoustic tag manager">
    {#each project.acousticTags as tag (tag.id)}
      <div>
        <input
          aria-label={`Rename ${tag.label}`}
          value={tag.label}
          on:blur={(event) => rename(tag.id, (event.currentTarget as HTMLInputElement).value)}
        />
        <button type="button" on:click={() => remove(tag.id)}>Remove {tag.label}</button>
      </div>
    {/each}

    <label>
      New acoustic tag
      <input aria-label="New acoustic tag" bind:value={nextLabel} />
    </label>
    <button type="button" on:click={add}>Add acoustic tag</button>

    {#if $store.saveError}
      <p role="alert">{$store.saveError}</p>
    {/if}
  </section>
{/if}
