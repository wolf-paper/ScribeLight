import { writable, type Readable } from 'svelte/store';
import type { NativeBridge, PlaybackSnapshot } from '../bridge/native';
import type { Selection } from '../domain/types';
import { formatUnknownError } from '../errors';

type AudioBridge = Pick<NativeBridge,
  'audioPlay' | 'audioPause' | 'audioSeek' | 'audioSetLoop' | 'audioClearLoop' |
  'audioSetVolume' | 'audioSnapshot' | 'audioClose'>;

const emptySnapshot = (): PlaybackSnapshot => ({
  state: 'empty', positionMs: 0, durationMs: 0, loopRange: null, volume: 1, underruns: 0
});

function validSelection(value: Selection | null, durationMs: number): boolean {
  return value === null || (
    Number.isInteger(value.startMs) && Number.isInteger(value.endMs) &&
    value.startMs >= 0 && value.endMs > value.startMs && value.endMs <= durationMs
  );
}

function assertSnapshot(value: PlaybackSnapshot): PlaybackSnapshot {
  const validState = value.state === 'empty' || value.state === 'paused' || value.state === 'playing'
    || (typeof value.state === 'object' && value.state !== null && typeof value.state.error === 'string');
  if (!validState || !Number.isInteger(value.positionMs) || !Number.isInteger(value.durationMs)
    || value.positionMs < 0 || value.durationMs < 0 || value.positionMs > value.durationMs
    || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1
    || !Number.isInteger(value.underruns) || value.underruns < 0
    || !validSelection(value.loopRange, value.durationMs)) {
    throw new Error('Native returned an invalid playback snapshot');
  }
  return value;
}

export class AudioSession implements Readable<PlaybackSnapshot> {
  private readonly state = writable(emptySnapshot());
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private lifecycle = 0;
  private refreshSequence = 0;
  private appliedRefresh = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private desiredLoop: Selection | null | undefined;
  private loopWorker: Promise<void> | null = null;
  readonly subscribe = this.state.subscribe;

  constructor(private readonly bridge: AudioBridge) {}

  startPolling(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.poll(), 33);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    this.assertOpen();
    const lifecycle = this.lifecycle;
    const sequence = ++this.refreshSequence;
    try {
      const snapshot = assertSnapshot(await this.bridge.audioSnapshot());
      if (lifecycle !== this.lifecycle || sequence < this.appliedRefresh) return;
      this.appliedRefresh = sequence;
      this.state.set(snapshot);
    } catch (error) {
      if (lifecycle !== this.lifecycle || sequence < this.appliedRefresh) return;
      this.appliedRefresh = sequence;
      this.setError(error);
      throw error;
    }
  }

  async play(): Promise<void> {
    await this.command(() => this.bridge.audioPlay());
  }

  async pause(): Promise<void> {
    await this.command(() => this.bridge.audioPause());
  }

  async seek(milliseconds: number): Promise<void> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new Error('Seek must be a non-negative integer millisecond value');
    await this.command(() => this.bridge.audioSeek(milliseconds));
  }

  setLoop(selection: Selection | null): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Audio session is closed'));
    if (selection && (!Number.isInteger(selection.startMs) || !Number.isInteger(selection.endMs)
      || selection.startMs < 0 || selection.endMs <= selection.startMs)) {
      return Promise.reject(new Error('Loop boundaries must be increasing integer milliseconds'));
    }
    this.desiredLoop = selection ? { ...selection } : null;
    if (!this.loopWorker) this.loopWorker = this.applyDesiredLoops();
    return this.loopWorker;
  }

  async setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Volume must be between 0 and 1');
    await this.command(() => this.bridge.audioSetVolume(volume));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.stopPolling();
    this.lifecycle += 1;
    this.desiredLoop = undefined;
    this.closePromise = (async () => {
      try {
        await this.bridge.audioClose();
      } catch (error) {
        throw error;
      } finally {
        this.state.set(emptySnapshot());
      }
    })();
    return this.closePromise;
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.refresh();
    } catch {
      // The error snapshot is observable; polling remains alive for native recovery.
    } finally {
      this.pollInFlight = false;
    }
  }

  private async command(action: () => Promise<void>): Promise<void> {
    this.assertOpen();
    const lifecycle = this.lifecycle;
    try {
      await action();
      if (this.closed || lifecycle !== this.lifecycle) return;
      await this.refresh();
    } catch (error) {
      if (this.closed || lifecycle !== this.lifecycle) return;
      this.setError(error);
      throw error;
    }
  }

  private async applyDesiredLoops(): Promise<void> {
    const lifecycle = this.lifecycle;
    try {
      while (!this.closed && this.desiredLoop !== undefined && lifecycle === this.lifecycle) {
        const next = this.desiredLoop;
        this.desiredLoop = undefined;
        try {
          if (next) await this.bridge.audioSetLoop(next);
          else await this.bridge.audioClearLoop();
        } catch (error) {
          this.setError(error);
          throw error;
        }
      }
      if (!this.closed && lifecycle === this.lifecycle) await this.refresh();
    } finally {
      this.loopWorker = null;
      if (!this.closed && this.desiredLoop !== undefined && lifecycle === this.lifecycle) this.loopWorker = this.applyDesiredLoops();
    }
  }

  private setError(error: unknown): void {
    if (this.closed) return;
    this.state.update((value) => ({ ...value, state: { error: formatUnknownError(error) } }));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Audio session is closed');
  }
}
