import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

/**
 * Module-level AsyncLocalStorage for correlation IDs.
 * This is NOT a NestJS service - it's a standalone module with singleton storage.
 */
const correlationStorage = new AsyncLocalStorage<string>();

/**
 * Wraps an async function with a new correlation ID context.
 * All code executed within this context (including nested calls) will have access to the same correlation ID.
 *
 * @param fn The async function to execute within the correlation context
 * @returns Promise resolving to the function's return value
 *
 * @example
 * await withCorrelationId(async () => {
 *   // All logs here will have the same correlationId
 *   this.logger.log({ message: 'Doing work' });
 *   await this.someService.doMore();
 * });
 */
export function withCorrelationId<T>(fn: () => Promise<T>): Promise<T> {
  const correlationId = uuidv4();
  return correlationStorage.run(correlationId, fn);
}

/**
 * Gets the current correlation ID from the async context.
 * Returns undefined if not currently in a correlation context (i.e., not wrapped with withCorrelationId).
 *
 * @returns The current correlation ID, or undefined if outside correlation context
 *
 * @example
 * const id = getCorrelationId(); // Returns UUID if in context, undefined otherwise
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
