import { describe, it, expect, vi } from 'vitest';
import { BatchCompleteEvent } from './batch.events';
import type { BatchPositionResult } from '../interfaces/position-close-service.interface';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('BatchCompleteEvent', () => {
  it('should create event with batchId and results', () => {
    const results: BatchPositionResult[] = [
      {
        positionId: 'pos-1',
        pairName: 'BTC > 50k',
        status: 'success',
        realizedPnl: '0.01500000',
      },
      {
        positionId: 'pos-2',
        pairName: 'ETH > 3k',
        status: 'failure',
        error: 'Order book empty',
      },
    ];

    const event = new BatchCompleteEvent('batch-123', results);

    expect(event.batchId).toBe('batch-123');
    expect(event.results).toEqual(results);
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use explicit correlationId when provided', () => {
    const event = new BatchCompleteEvent('batch-456', [], 'explicit-corr-id');

    expect(event.correlationId).toBe('explicit-corr-id');
  });

  it('should handle empty results array', () => {
    const event = new BatchCompleteEvent('batch-empty', []);

    expect(event.batchId).toBe('batch-empty');
    expect(event.results).toEqual([]);
  });
});
