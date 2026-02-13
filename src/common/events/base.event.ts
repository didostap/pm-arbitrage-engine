import { getCorrelationId } from '../services/correlation-context';

/**
 * Base class for all domain events.
 * Provides common fields: timestamp and correlationId.
 *
 * IMPORTANT: Constructor parameter correlationId is OPTIONAL for backward compatibility.
 * If not provided, it will attempt to get correlationId from async context.
 */
export abstract class BaseEvent {
  public readonly timestamp: Date;
  public readonly correlationId: string | undefined;

  /**
   * @param correlationId Optional correlation ID. If not provided, attempts to get from async context.
   */
  protected constructor(correlationId?: string) {
    this.timestamp = new Date();
    this.correlationId = correlationId ?? getCorrelationId();
  }
}
