<script lang="ts">
  import { onMount } from 'svelte';
  import type { MultilinePolicy } from '../domain/types';
  import type { ProjectState, ProjectStore } from '../state/projectStore';
  import type { PaletteId } from '../theme/palette';
  import AcousticTagManager from './AcousticTagManager.svelte';
  import PaletteSelector from './PaletteSelector.svelte';
  import SpeakerManager from './SpeakerManager.svelte';

  interface Props {
    store: ProjectStore | null;
    palette: PaletteId;
    multilinePolicy: MultilinePolicy;
    disabled?: boolean;
    onpalette(value: PaletteId): void;
    onpolicy(value: MultilinePolicy): void;
    onclose(): void;
  }

  let { store, palette, multilinePolicy, disabled = false, onpalette, onpolicy, onclose }: Props = $props();
  let dialog: HTMLDialogElement;
  let closeButton: HTMLButtonElement;
  let projectState: ProjectState | null = $state(null);

  $effect(() => {
    if (!store) {
      projectState = null;
      return;
    }
    return store.subscribe((value) => projectState = value);
  });

  onMount(() => {
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    closeButton.focus();

    return () => {
      if (!dialog.open) return;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  });

  function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onclose();
  }

  function cancel(event: Event): void {
    event.preventDefault();
    onclose();
  }

  function containFocus(event: FocusEvent): void {
    const target = event.target;
    if (dialog?.open && target instanceof Node && !dialog.contains(target)) closeButton.focus();
  }
</script>

<svelte:window onfocusin={containFocus} />

<div class="settings-backdrop">
  <dialog bind:this={dialog} aria-labelledby="settings-title" onkeydown={keydown} oncancel={cancel}>
    <header class="settings-header">
      <h2 id="settings-title">Settings</h2>
      <button bind:this={closeButton} type="button" aria-label="Close settings" onclick={onclose}>Close</button>
    </header>

    <nav aria-label="Settings sections">
      <a href="#settings-appearance">Appearance</a>
      <a href="#settings-project-labels">Project labels</a>
      <a href="#settings-export">Export</a>
    </nav>

    <div class="settings-content">
      <section id="settings-appearance" class="settings-section" aria-labelledby="settings-appearance-title">
        <h3 id="settings-appearance-title">Appearance</h3>
        <PaletteSelector value={palette} {disabled} onchange={onpalette} />
      </section>

      <section id="settings-project-labels" class="settings-section" aria-labelledby="settings-project-labels-title">
        <h3 id="settings-project-labels-title">Project labels</h3>
        {#if store}
          <div class="label-managers">
            <SpeakerManager {store} {disabled} />
            <AcousticTagManager {store} {disabled} />
            {#if projectState?.saveError}
              <p role="alert">{projectState.saveError}</p>
            {/if}
          </div>
        {:else}
          <p class="settings-empty">Open a project to manage labels.</p>
        {/if}
      </section>

      <section id="settings-export" class="settings-section" aria-labelledby="settings-export-title">
        <h3 id="settings-export-title">Export</h3>
        <label class="settings-field">
          <span>Multiline export policy</span>
          <select aria-label="Multiline export policy" value={multilinePolicy} {disabled}
            onchange={(event) => onpolicy((event.currentTarget as HTMLSelectElement).value as MultilinePolicy)}>
            <option value="escape">Escape line breaks as \n</option>
            <option value="space">Replace line breaks with spaces</option>
            <option value="quoted">Preserve line breaks in quoted fields</option>
          </select>
        </label>
      </section>
    </div>
  </dialog>
</div>
