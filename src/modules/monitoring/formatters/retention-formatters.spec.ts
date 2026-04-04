import { describe, it, expect } from 'vitest';
import { formatTimescaleRetentionCompleted } from './retention-formatters.js';

describe('formatTimescaleRetentionCompleted', () => {
  it('should format retention completion with per-table chunk counts', () => {
    const result = formatTimescaleRetentionCompleted({
      droppedChunks: {
        historical_prices: 5,
        historical_depths: 3,
        historical_trades: 1,
      },
      durationMs: 12345,
      timestamp: new Date('2026-04-04T04:00:00Z'),
    });

    expect(result).toContain('TimescaleDB Retention Completed');
    expect(result).toContain('historical_prices: 5 chunks dropped');
    expect(result).toContain('historical_depths: 3 chunks dropped');
    expect(result).toContain('historical_trades: 1 chunks dropped');
    expect(result).toContain('Duration: 12.3s');
  });

  it('should handle zero dropped chunks', () => {
    const result = formatTimescaleRetentionCompleted({
      droppedChunks: {
        historical_prices: 0,
        historical_depths: 0,
        historical_trades: 0,
      },
      durationMs: 500,
      timestamp: new Date(),
    });

    expect(result).toContain('0 chunks dropped');
    expect(result).toContain('Duration: 0.5s');
  });

  it('should handle empty droppedChunks (all tables skipped)', () => {
    const result = formatTimescaleRetentionCompleted({
      droppedChunks: {},
      durationMs: 100,
      timestamp: new Date(),
    });

    expect(result).toContain('No tables processed');
    expect(result).toContain('Duration: 0.1s');
  });
});
