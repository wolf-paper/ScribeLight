export function formatUnknownError(error: unknown, fallback = 'The operation failed'): string {
  if (error && typeof error === 'object') {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    } catch {
      // Some foreign error objects expose throwing getters; use the safe fallback below.
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
