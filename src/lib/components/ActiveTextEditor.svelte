<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';

  export let store: ProjectStore;
  export let disabled = false;
  export let onsubmit: () => void;

  function submit(event: KeyboardEvent): void {
    if (disabled || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    onsubmit();
  }

  function update(event: Event): void {
    if (!disabled) store.patchDraft({ transcription: (event.currentTarget as HTMLTextAreaElement).value });
  }
</script>

{#if $store.project}
  <section class="active-text-editor" aria-label="Transcription editor">
    <h2>Transcription</h2>
    <fieldset {disabled}>
      <textarea
        aria-label="Transcription"
        rows="4"
        value={$store.project.draft.transcription}
        on:input={update}
        on:keydown={submit}
      ></textarea>
    </fieldset>
  </section>
{/if}
