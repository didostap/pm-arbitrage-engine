import { describe, it, expect } from 'vitest';
import { BaseEvent } from './base.event';
import { withCorrelationId } from '../services/correlation-context';

// Create a concrete test event class for testing
class TestEvent extends BaseEvent {
  constructor(
    public readonly testData: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

describe('BaseEvent', () => {
  it('should set timestamp as Date object', () => {
    const event = new TestEvent('test data');

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('should use provided correlationId if given', () => {
    const providedId = 'test-correlation-id-123';
    const event = new TestEvent('test data', providedId);

    expect(event.correlationId).toBe(providedId);
  });

  it('should get correlationId from context if not provided', async () => {
    await withCorrelationId(async () => {
      const event = new TestEvent('test data'); // No correlationId param

      expect(event.correlationId).toBeDefined();
      expect(typeof event.correlationId).toBe('string');

      // Verify UUID format
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(event.correlationId!)).toBe(true);
      await Promise.resolve(); // Satisfy async requirement
    });
  });

  it('should have undefined correlationId when outside context and not provided', () => {
    const event = new TestEvent('test data'); // No context, no param

    expect(event.correlationId).toBeUndefined();
  });

  it('should prefer provided correlationId over context', async () => {
    const providedId = 'explicit-id';

    await withCorrelationId(async () => {
      const event = new TestEvent('test data', providedId);

      // Should use provided ID, not context ID
      expect(event.correlationId).toBe(providedId);
      await Promise.resolve(); // Satisfy async requirement
    });
  });

  it('should have valid timestamp', () => {
    const beforeCreate = Date.now();
    const event = new TestEvent('test data');
    const afterCreate = Date.now();

    const eventTime = event.timestamp.getTime();
    expect(eventTime).toBeGreaterThanOrEqual(beforeCreate);
    expect(eventTime).toBeLessThanOrEqual(afterCreate);
  });
});
