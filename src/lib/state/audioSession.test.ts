import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../bridge/native';
import { AudioSession } from './audioSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const snapshot = (positionMs: number, loopRange: PlaybackSnapshot['loopRange'] = null): PlaybackSnapshot => ({
  state: 'paused', positionMs, durationMs: 1_000, loopRange, volume: 1, underruns: 0
});

describe('AudioSession', () => {
  const bridge = {
    audioPlay: vi.fn<() => Promise<void>>(async () => undefined),
    audioPause: vi.fn<() => Promise<void>>(async () => undefined),
    audioSeek: vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined),
    audioSetLoop: vi.fn<(selection: { startMs: number; endMs: number }) => Promise<void>>(async () => undefined),
    audioClearLoop: vi.fn<() => Promise<void>>(async () => undefined),
    audioSetVolume: vi.fn<(volume: number) => Promise<void>>(async () => undefined),
    audioClose: vi.fn<() => Promise<void>>(async () => undefined),
    audioSnapshot: vi.fn<() => Promise<PlaybackSnapshot>>(async () => snapshot(123))
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.audioSnapshot.mockResolvedValue(snapshot(123));
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('polls at most one authoritative native snapshot at a time and starts idempotently', async () => {
    const pending = deferred<PlaybackSnapshot>();
    bridge.audioSnapshot.mockReturnValue(pending.promise);
    const session = new AudioSession(bridge);

    session.startPolling();
    session.startPolling();
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.audioSnapshot).toHaveBeenCalledTimes(1);

    pending.resolve(snapshot(321));
    await Promise.resolve();
    expect(get(session).positionMs).toBe(321);
    await session.close();
  });

  it('ignores an older out-of-order refresh result', async () => {
    const first = deferred<PlaybackSnapshot>();
    const second = deferred<PlaybackSnapshot>();
    bridge.audioSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new AudioSession(bridge);

    const oldRefresh = session.refresh();
    const newRefresh = session.refresh();
    second.resolve(snapshot(800));
    await newRefresh;
    first.resolve(snapshot(100));
    await oldRefresh;

    expect(get(session).positionMs).toBe(800);
  });

  it('forwards commands exactly and rejects impossible frontend values before native calls', async () => {
    const session = new AudioSession(bridge);
    await session.play();
    await session.pause();
    await session.seek(250);
    await session.setVolume(0.4);

    expect(bridge.audioPlay).toHaveBeenCalledTimes(1);
    expect(bridge.audioPause).toHaveBeenCalledTimes(1);
    expect(bridge.audioSeek).toHaveBeenCalledWith(250);
    expect(bridge.audioSetVolume).toHaveBeenCalledWith(0.4);
    await expect(session.seek(-1)).rejects.toThrow('Seek');
    await expect(session.setVolume(2)).rejects.toThrow('Volume');
    expect(bridge.audioSeek).toHaveBeenCalledTimes(1);
    expect(bridge.audioSetVolume).toHaveBeenCalledTimes(1);
  });

  it('serializes and coalesces loop changes so an old response cannot win', async () => {
    const first = deferred<void>();
    bridge.audioSetLoop.mockReturnValueOnce(first.promise);
    bridge.audioSnapshot.mockImplementation(async () => snapshot(0, { startMs: 30, endMs: 40 }));
    const session = new AudioSession(bridge);

    const oldLoop = session.setLoop({ startMs: 10, endMs: 20 });
    const latestLoop = session.setLoop({ startMs: 30, endMs: 40 });
    expect(bridge.audioSetLoop).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([oldLoop, latestLoop]);

    expect(bridge.audioSetLoop.mock.calls).toEqual([
      [{ startMs: 10, endMs: 20 }],
      [{ startMs: 30, endMs: 40 }]
    ]);
    expect(get(session).loopRange).toEqual({ startMs: 30, endMs: 40 });
  });

  it('stops first, invalidates in-flight snapshots, and closes the native stream once reentrantly', async () => {
    const pendingSnapshot = deferred<PlaybackSnapshot>();
    const pendingClose = deferred<void>();
    bridge.audioSnapshot.mockReturnValue(pendingSnapshot.promise);
    bridge.audioClose.mockReturnValue(pendingClose.promise);
    const session = new AudioSession(bridge);
    session.startPolling();
    await vi.advanceTimersByTimeAsync(33);

    const firstClose = session.close();
    const secondClose = session.close();
    pendingSnapshot.resolve(snapshot(900));
    pendingClose.resolve();
    await Promise.all([firstClose, secondClose]);

    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
    expect(get(session)).toMatchObject({ state: 'empty', positionMs: 0, durationMs: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.audioSnapshot).toHaveBeenCalledTimes(1);
  });

  it('surfaces native command and malformed snapshot errors without accepting invalid state', async () => {
    bridge.audioPlay.mockRejectedValueOnce(new Error('device lost'));
    const session = new AudioSession(bridge);
    await expect(session.play()).rejects.toThrow('device lost');
    expect(get(session).state).toEqual({ error: 'device lost' });

    bridge.audioSnapshot.mockResolvedValueOnce({ ...snapshot(0), positionMs: Number.NaN });
    await expect(session.refresh()).rejects.toThrow('invalid playback snapshot');
    expect(get(session).state).toEqual({ error: expect.stringContaining('invalid playback snapshot') });
  });

  it('surfaces production-shaped polling errors using their native message', async () => {
    bridge.audioSnapshot.mockRejectedValueOnce({ kind: 'audio', message: 'device polling failed' });
    const session = new AudioSession(bridge);

    session.startPolling();
    await vi.advanceTimersByTimeAsync(33);

    expect(get(session).state).toEqual({ error: 'device polling failed' });
    await session.close();
  });

  it('is terminal after close and rejects every later operation without polling or native calls', async () => {
    const session = new AudioSession(bridge);
    await session.close();
    vi.clearAllMocks();

    session.startPolling();
    await vi.advanceTimersByTimeAsync(100);
    await expect(session.refresh()).rejects.toThrow('closed');
    await expect(session.play()).rejects.toThrow('closed');
    await expect(session.pause()).rejects.toThrow('closed');
    await expect(session.seek(1)).rejects.toThrow('closed');
    await expect(session.setLoop({ startMs: 1, endMs: 2 })).rejects.toThrow('closed');
    await expect(session.setVolume(0.5)).rejects.toThrow('closed');
    await session.close();

    expect(bridge.audioSnapshot).not.toHaveBeenCalled();
    expect(bridge.audioPlay).not.toHaveBeenCalled();
    expect(bridge.audioPause).not.toHaveBeenCalled();
    expect(bridge.audioSeek).not.toHaveBeenCalled();
    expect(bridge.audioSetLoop).not.toHaveBeenCalled();
    expect(bridge.audioSetVolume).not.toHaveBeenCalled();
    expect(bridge.audioClose).not.toHaveBeenCalled();
    expect(get(session)).toEqual({ state: 'empty', positionMs: 0, durationMs: 0, loopRange: null, volume: 1, underruns: 0 });
  });

  it('does not refresh or resurrect state when a command settles after close', async () => {
    const pendingPlay = deferred<void>();
    bridge.audioPlay.mockReturnValueOnce(pendingPlay.promise);
    const session = new AudioSession(bridge);
    const play = session.play();

    await session.close();
    pendingPlay.resolve();
    await expect(play).resolves.toBeUndefined();

    expect(bridge.audioSnapshot).not.toHaveBeenCalled();
    expect(get(session).state).toBe('empty');
  });
});
