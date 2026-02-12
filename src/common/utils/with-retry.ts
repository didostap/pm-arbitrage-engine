import { RetryStrategy } from '../errors/index.js';

/**
 * Execute an async function with exponential backoff retry.
 * Adds jitter to prevent thundering herd.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  strategy: RetryStrategy,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= strategy.maxRetries) {
        break;
      }

      const baseDelay =
        strategy.initialDelayMs * Math.pow(strategy.backoffMultiplier, attempt);
      const cappedDelay = Math.min(baseDelay, strategy.maxDelayMs);
      // Add jitter: 0.5x to 1.5x of the computed delay
      const jitter = cappedDelay * (0.5 + Math.random());
      const delay = Math.min(jitter, strategy.maxDelayMs);

      onRetry?.(attempt + 1, lastError);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
