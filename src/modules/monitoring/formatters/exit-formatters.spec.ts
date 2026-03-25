import { describe, it, expect } from 'vitest';
import { formatExitTriggered } from './exit-formatters.js';

describe('formatExitTriggered', () => {
  it('should show exit type and P&L', () => {
    const result = formatExitTriggered({
      positionId: 'pos-1',
      pairId: 'pair-1',
      exitType: 'take_profit',
      initialEdge: '0.0120',
      finalEdge: '0.0005',
      realizedPnl: '+$3.50',
      kalshiCloseOrderId: 'k-close-1',
      polymarketCloseOrderId: 'p-close-1',
      timestamp: new Date(),
    });

    expect(result).toContain('Take Profit');
    expect(result).toContain('+$3.50');
  });

  it('should use raw exit type as fallback for unknown types', () => {
    const result = formatExitTriggered({
      positionId: 'pos-1',
      pairId: 'pair-1',
      exitType: 'edge_evaporation',
      initialEdge: '0.0120',
      finalEdge: '0.0005',
      realizedPnl: '-$1.00',
      kalshiCloseOrderId: 'k-close-1',
      polymarketCloseOrderId: 'p-close-1',
      timestamp: new Date(),
    });

    expect(result).toContain('Edge Evaporation');
    expect(result).not.toContain('Time-Based');
  });
});
