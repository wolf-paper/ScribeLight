<script lang="ts">
  import { addLabel, removeTag, renameTag } from '../domain/project';
  import type { ProjectStore } from '../state/projectStore';
  import { stableColorSlot } from '../theme/palette';

  export let store: ProjectStore;
  export let disabled = false;

  let nextLabel = '';

  async function add(): Promise<void> {
    if (await store.mutateProject((project) => addLabel(project, 'acousticTags', nextLabel))) nextLabel = '';
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
  <section class="label-manager" aria-label="Acoustic tag manager">
    <h4>Acoustic tags</h4>
    {#each project.acousticTags as tag (tag.id)}
      <div class="label-row">
        <label>
          <span class="label-name">
            <span
              class="tag-color-cue"
              data-testid={`tag-manager-cue-${tag.id}`}
              data-color-slot={stableColorSlot(tag.id, 5)}
              aria-hidden="true"
            ></span>
            <span>Name</span>
          </span>
          <input
            aria-label={`Rename ${tag.label}`}
            value={tag.label}
            {disabled}
            on:blur={(event) => rename(tag.id, (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <button type="button" {disabled} on:click={() => remove(tag.id)}>Remove {tag.label}</button>
      </div>
    {/each}

    <label>
      <span>New acoustic tag</span>
      <input aria-label="New acoustic tag" bind:value={nextLabel} {disabled} />
    </label>
    <button type="button" {disabled} on:click={add}>Add acoustic tag</button>
  </section>
{/if}
