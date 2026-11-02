<script lang="ts">
  import { formatTime } from '../domain/time';

  interface Props {
    positionMs: number;
    durationMs: number;
    playing: boolean;
    loopEnabled: boolean;
    canLoop: boolean;
    volume: number;
    disabled?: boolean;
    ontoggleplay: () => void;
    onskip: (deltaMs: number) => void;
    ontoggleloop: () => void;
    onvolume: (volume: number) => void;
  }

  let {
    positionMs, durationMs, playing, loopEnabled, canLoop, volume, disabled = false,
    ontoggleplay, onskip, ontoggleloop, onvolume
  }: Props = $props();
</script>

<div class="transport" role="toolbar" aria-label="Playback">
  <button type="button" class="ghost" {disabled} aria-label="Back 1 second" title="Back 1 second (Shift+←)" onclick={() => onskip(-1_000)}>−1 s</button>
  <button type="button" class="play-button" {disabled} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause (Space)" onclick={ontoggleplay}>
    <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
    {playing ? 'Pause' : 'Play'}
    <kbd>Space</kbd>
  </button>
  <button type="button" class="ghost" {disabled} aria-label="Forward 1 second" title="Forward 1 second (Shift+→)" onclick={() => onskip(1_000)}>+1 s</button>
  <p class="position num" aria-label="Playback position">
    <span>{formatTime(positionMs)}</span>
    <span class="muted">/ {formatTime(durationMs)}</span>
  </p>
  <button
    type="button"
    class="ghost"
    aria-pressed={loopEnabled}
    disabled={disabled || (!canLoop && !loopEnabled)}
    title="Repeat the marked range (L)"
    onclick={ontoggleloop}
  >
    Loop range <kbd>L</kbd>
  </button>
  <label class="volume">
    <span>Volume</span>
    <input
      aria-label="Volume"
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={volume}
      {disabled}
      oninput={(event) => onvolume(+event.currentTarget.value)}
    />
  </label>
</div>
