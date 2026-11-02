<script module lang="ts">
  export interface SegmentOption<V extends string> {
    value: V;
    label: string;
    hint?: string;
    colorSlot?: number;
    /** Accessible name when the visible label is abbreviated. */
    ariaLabel?: string;
  }
</script>

<script lang="ts" generics="T extends string">
  interface Props {
    label: string;
    options: SegmentOption<T>[];
    value: T | null;
    disabled?: boolean;
    invalid?: boolean;
    onchange: (value: T) => void;
  }

  let { label, options, value, disabled = false, invalid = false, onchange }: Props = $props();
  let group: HTMLDivElement;

  const focusIndex = $derived(Math.max(0, options.findIndex((option) => option.value === value)));

  function keydown(event: KeyboardEvent, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onchange(options[next].value);
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
</script>

<div
  bind:this={group}
  class="segmented"
  role="radiogroup"
  aria-label={label}
  aria-invalid={invalid ? 'true' : undefined}
  aria-disabled={disabled ? 'true' : undefined}
>
  {#each options as option, index (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={option.value === value}
      tabindex={index === focusIndex ? 0 : -1}
      title={option.hint}
      aria-label={option.ariaLabel}
      {disabled}
      onclick={() => onchange(option.value)}
      onkeydown={(event) => keydown(event, index)}
    >
      {#if option.colorSlot !== undefined}
        <span class="segment-dot" data-color-slot={option.colorSlot} aria-hidden="true"></span>
      {/if}
      {option.label}
    </button>
  {/each}
</div>
