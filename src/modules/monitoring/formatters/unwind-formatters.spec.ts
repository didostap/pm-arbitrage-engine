import { describe, it, expect } from 'vitest';
import { formatAutoUnwind } from './unwind-formatters.js';

describe('formatAutoUnwind', () => {
  it('should show success result with check emoji', () => {
    const result = formatAutoUnwind({
      positionId: 'pos-1',
      pairId: 'pair-1',
      action: 'close_both_legs',
      result: 'success',
      estimatedLossPct: null,
      realizedPnl: '-$2.50',
      timeElapsedMs: 1200,
      simulated: false,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{2705}'); // check emoji
    expect(result).toContain('AUTO-UNWIND SUCCESS');
    expect(result).toContain('pos-1');
    expect(result).toContain('-$2.50');
    expect(result).toContain('1200ms');
  });

  it('should show failed result with cross emoji', () => {
    const result = formatAutoUnwind({
      positionId: 'pos-2',
      pairId: 'pair-2',
      action: 'close_filled_leg',
      result: 'failed',
      estimatedLossPct: 3.5,
      realizedPnl: null,
      timeElapsedMs: 5000,
      simulated: false,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{274C}'); // cross emoji
    expect(result).toContain('AUTO-UNWIND FAILED');
    expect(result).toContain('~3.50%');
  });

  it('should include paper mode and simulated tags', () => {
    const result = formatAutoUnwind({
      positionId: 'pos-3',
      pairId: 'pair-3',
      action: 'close_both_legs',
      result: 'success',
      estimatedLossPct: null,
      realizedPnl: null,
      timeElapsedMs: 800,
      simulated: true,
      isPaper: true,
      timestamp: new Date(),
    });

    expect(result).toContain('[PAPER]');
    expect(result).toContain('[SIMULATED]');
    expect(result).toContain('N/A'); // no realized PnL or estimated loss
  });
});
