import { describe, expect, it } from 'vitest';
import { moveSelection, normalizeSelection } from './selection';

describe('selection', () => {
  it('rounds and clamps a valid range', () => {
    expect(normalizeSelection(10.4, 101.6, 100)).toEqual({ startMs: 10, endMs: 100 });
  });

  it('rejects an empty range', () => {
    expect(normalizeSelection(10, 10, 100)).toBeNull();
  });

  it('moves without changing duration or leaving the clip', () => {
    expect(moveSelection({ startMs: 80, endMs: 100 }, 30, 110)).toEqual({ startMs: 90, endMs: 110 });
  });
});
