<script context="module" lang="ts">
  let nextInstanceId = 0;
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import type { LabelDefinition } from '../domain/types';
  import { stableColorSlot } from '../theme/palette';

  export let tags: LabelDefinition[];
  export let selectedIds: string[];
  export let disabled = false;
  export let onchange: (ids: string[]) => void;

  const instanceId = ++nextInstanceId;
  const listboxId = `acoustic-tag-listbox-${instanceId}`;
  const tagColorVariables = ['--tag-cyan', '--tag-violet', '--tag-rose', '--tag-amber', '--tag-mint'] as const;

  let rootElement: HTMLDivElement;
  let triggerElement: HTMLButtonElement;
  let searchElement: HTMLInputElement;
  let open = false;
  let query = '';
  let activeIndex = -1;

  $: filteredTags = tags.filter((tag) => tag.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  $: selectedTags = tags.filter((tag) => selectedIds.includes(tag.id));
  $: if (activeIndex >= filteredTags.length) activeIndex = filteredTags.length - 1;
  $: if (disabled && open) close();

  function optionId(tag: LabelDefinition): string {
    return `acoustic-tag-option-${instanceId}-${tags.indexOf(tag)}`;
  }

  function tagColor(tagId: string): string {
    return `var(${tagColorVariables[stableColorSlot(tagId, tagColorVariables.length)]})`;
  }

  async function toggleOpen(): Promise<void> {
    if (disabled) return;
    open = !open;
    if (!open) return;
    query = '';
    activeIndex = -1;
    await tick();
    searchElement?.focus();
  }

  async function close(restoreFocus = false): Promise<void> {
    if (!open) return;
    open = false;
    activeIndex = -1;
    if (restoreFocus) {
      await tick();
      triggerElement?.focus();
    }
  }

  function publishSelection(ids: Iterable<string>): void {
    if (disabled) return;
    const requested = new Set(ids);
    onchange(tags.filter((tag) => requested.has(tag.id)).map((tag) => tag.id));
  }

  function toggleTag(tagId: string): void {
    if (disabled) return;
    const nextIds = new Set(selectedIds);
    if (nextIds.has(tagId)) nextIds.delete(tagId);
    else nextIds.add(tagId);
    publishSelection(nextIds);
  }

  function removeTag(tagId: string): void {
    if (disabled) return;
    publishSelection(selectedIds.filter((id) => id !== tagId));
  }

  function searchInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    activeIndex = -1;
  }

  async function scrollOptionIntoView(tag: LabelDefinition): Promise<void> {
    await tick();
    document.getElementById(optionId(tag))?.scrollIntoView?.({ block: 'nearest' });
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void close(true);
      return;
    }
    if (!filteredTags.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % filteredTags.length;
      void scrollOptionIntoView(filteredTags[activeIndex]);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = activeIndex <= 0 ? filteredTags.length - 1 : activeIndex - 1;
      void scrollOptionIntoView(filteredTags[activeIndex]);
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      toggleTag(filteredTags[activeIndex].id);
    }
  }

  function windowClick(event: MouseEvent): void {
    if (open && !rootElement?.contains(event.target as Node)) void close();
  }
</script>

<svelte:window on:click={windowClick} />

<div class="acoustic-tag-select" bind:this={rootElement}>
  {#if selectedTags.length}
    <ul class="selected-tag-list" aria-label="Selected acoustic tags">
      {#each selectedTags as tag (tag.id)}
        <li class="selected-tag-chip" style={`--tag-color: ${tagColor(tag.id)}`}>
          <span>{tag.label}</span>
          <button
            type="button"
            aria-label={`Remove ${tag.label} acoustic tag`}
            title={`Remove ${tag.label}`}
            {disabled}
            on:click={() => removeTag(tag.id)}
          >x</button>
        </li>
      {/each}
    </ul>
  {/if}

  <button
    class="acoustic-tag-trigger"
    type="button"
    role="combobox"
    aria-label="Acoustic tags"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open && activeIndex >= 0 ? optionId(filteredTags[activeIndex]) : undefined}
    {disabled}
    bind:this={triggerElement}
    on:click={toggleOpen}
  >
    <span>{selectedTags.length ? `${selectedTags.length} selected` : 'Select tags'}</span>
    <span aria-hidden="true">v</span>
  </button>

  {#if open}
    <div class="acoustic-tag-popup">
      <input
        type="search"
        aria-label="Search acoustic tags"
        placeholder="Search tags"
        value={query}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? optionId(filteredTags[activeIndex]) : undefined}
        autocomplete="off"
        bind:this={searchElement}
        on:input={searchInput}
        on:keydown={searchKeydown}
      />
      <div id={listboxId} class="acoustic-tag-listbox" role="listbox" aria-label="Acoustic tags" aria-multiselectable="true">
        {#each filteredTags as tag, index (tag.id)}
          {@const selected = selectedIds.includes(tag.id)}
          <button
            id={optionId(tag)}
            class:active-option={index === activeIndex}
            type="button"
            role="option"
            aria-selected={selected}
            tabindex="-1"
            on:click={() => toggleTag(tag.id)}
          >
            <span class="tag-check" aria-hidden="true">{selected ? '\u2713' : ''}</span>
            <span>{tag.label}</span>
          </button>
        {/each}
        {#if !filteredTags.length}
          <div class="no-tag-results">No matching tags</div>
        {/if}
      </div>
    </div>
  {/if}
</div>
