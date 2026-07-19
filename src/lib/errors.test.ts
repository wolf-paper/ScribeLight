import { describe, expect, it } from 'vitest';
import { formatUnknownError } from './errors';

describe('formatUnknownError', () => {
  it('uses production Tauri object messages without stringifying the object', () => {
    expect(formatUnknownError({ kind: 'persistence', message: 'disk full' })).toBe('disk full');
  });

  it('handles Error, string, and unusable unknown values safely', () => {
    expect(formatUnknownError(new Error('device lost'))).toBe('device lost');
    expect(formatUnknownError('plain failure')).toBe('plain failure');
    expect(formatUnknownError({ kind: 'persistence', message: 42 })).toBe('The operation failed');
    expect(formatUnknownError(null)).toBe('The operation failed');
  });
});
