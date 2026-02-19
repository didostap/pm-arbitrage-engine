import { describe, it, expect } from 'vitest';
import {
  calculateSingleLegPnlScenarios,
  buildRecommendedActions,
  type SingleLegPnlInput,
} from './single-leg-pnl.util';
import { PlatformId } from '../../common/types/platform.type';

describe('calculateSingleLegPnlScenarios', () => {
  const baseInput: SingleLegPnlInput = {
    filledPlatform: PlatformId.KALSHI,
    filledSide: 'buy',
    fillPrice: 0.45,
    fillSize: 200,
    currentPrices: {
      kalshi: { bestBid: 0.44, bestAsk: 0.46 },
      polymarket: { bestBid: 0.54, bestAsk: 0.56 },
    },
    secondaryPlatform: PlatformId.POLYMARKET,
    secondarySide: 'sell',
    takerFeeDecimal: 0.02,
    secondaryTakerFeeDecimal: 0.02,
  };

  describe('closeNow estimate', () => {
    it('should calculate loss when unwinding a buy at best bid', () => {
      const result = calculateSingleLegPnlScenarios(baseInput);
      // Unwind buy by selling at best bid: (0.44 - 0.45) * 200 = -2.00
      // Taker fee on unwind: 0.44 * 200 * 0.02 = 1.76
      // Total: -2.00 - 1.76 = -3.76
      expect(result.closeNowEstimate).toBe('-3.76');
    });

    it('should calculate gain when unwinding a sell at best ask', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        filledPlatform: PlatformId.POLYMARKET,
        filledSide: 'sell',
        fillPrice: 0.55,
        fillSize: 182,
        secondaryPlatform: PlatformId.KALSHI,
        secondarySide: 'buy',
      };
      const result = calculateSingleLegPnlScenarios(input);
      // Unwind sell by buying at best ask on polymarket: (0.55 - 0.56) * 182 = -1.82
      // Taker fee on unwind: 0.56 * 182 * 0.02 = 2.0384
      // Total: -1.82 - 2.0384 = -3.8584
      expect(Number(result.closeNowEstimate)).toBeCloseTo(-3.8584, 2);
    });

    it('should return UNAVAILABLE when order book is empty', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        currentPrices: {
          kalshi: { bestBid: null, bestAsk: null },
          polymarket: { bestBid: 0.54, bestAsk: 0.56 },
        },
      };
      const result = calculateSingleLegPnlScenarios(input);
      expect(result.closeNowEstimate).toBe('UNAVAILABLE');
    });
  });

  describe('retryAtCurrentPrice estimate', () => {
    it('should calculate positive edge when retry is profitable', () => {
      const result = calculateSingleLegPnlScenarios(baseInput);
      // Secondary sell at current best bid on polymarket: 0.54
      // Edge: |0.45 - 0.54| = 0.09
      // Fees: fillPrice * takerFee + secondaryPrice * secondaryTakerFee
      // = 0.45 * 0.02 + 0.54 * 0.02 = 0.009 + 0.0108 = 0.0198
      // Net edge: 0.09 - 0.0198 = 0.0702
      // As percentage: 0.0702 / ((0.45 + 0.54) / 2) ≈ 14.18%
      expect(result.retryAtCurrentPrice).toContain('edge');
    });

    it('should indicate loss when retry is unprofitable', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        currentPrices: {
          kalshi: { bestBid: 0.44, bestAsk: 0.46 },
          polymarket: { bestBid: 0.44, bestAsk: 0.46 },
        },
      };
      const result = calculateSingleLegPnlScenarios(input);
      // Secondary sell at current best bid on polymarket: 0.44
      // Edge: |0.45 - 0.44| = 0.01
      // Fees: 0.45 * 0.02 + 0.44 * 0.02 = 0.009 + 0.0088 = 0.0178
      // Net: 0.01 - 0.0178 = -0.0078 (negative = loss)
      expect(result.retryAtCurrentPrice).toContain('loss');
    });

    it('should return UNAVAILABLE when secondary platform has no prices', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        currentPrices: {
          kalshi: { bestBid: 0.44, bestAsk: 0.46 },
          polymarket: { bestBid: null, bestAsk: null },
        },
      };
      const result = calculateSingleLegPnlScenarios(input);
      expect(result.retryAtCurrentPrice).toBe('UNAVAILABLE');
    });
  });

  describe('holdRiskAssessment', () => {
    it('should produce correct hold risk string', () => {
      const result = calculateSingleLegPnlScenarios(baseInput);
      expect(result.holdRiskAssessment).toBe(
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
      );
    });

    it('should append unavailable market warning when books are null', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        currentPrices: {
          kalshi: { bestBid: null, bestAsk: null },
          polymarket: { bestBid: null, bestAsk: null },
        },
      };
      const result = calculateSingleLegPnlScenarios(input);
      expect(result.holdRiskAssessment).toContain(
        'Current market prices unavailable',
      );
    });
  });

  describe('zero liquidity edge cases', () => {
    it('should handle zero fill size gracefully', () => {
      const input: SingleLegPnlInput = {
        ...baseInput,
        fillSize: 0,
      };
      const result = calculateSingleLegPnlScenarios(input);
      expect(result.closeNowEstimate).toBeDefined();
      expect(result.holdRiskAssessment).toContain('$0.00');
    });
  });
});

describe('buildRecommendedActions', () => {
  it('should recommend retry when edge is positive and not recommend close', () => {
    const pnl = {
      closeNowEstimate: '-3.76',
      retryAtCurrentPrice: 'Retry would yield ~14.18% edge',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    };
    const actions = buildRecommendedActions(pnl, 'pos-1');
    expect(actions.some((a) => a.includes('Retry'))).toBe(true);
    expect(actions.some((a) => a.includes('Close'))).toBe(false);
    expect(actions.some((a) => a.includes('Monitor'))).toBe(true);
  });

  it('should recommend close when retry is a loss', () => {
    const pnl = {
      closeNowEstimate: '-1.00',
      retryAtCurrentPrice: 'Retry at current price would result in ~2.5% loss',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    };
    const actions = buildRecommendedActions(pnl, 'pos-1');
    expect(actions.some((a) => a.includes('Close'))).toBe(true);
    expect(actions.some((a) => a.includes('Monitor'))).toBe(true);
  });

  it('should recommend close when retry is unavailable but close is available', () => {
    const pnl = {
      closeNowEstimate: '-2.50',
      retryAtCurrentPrice: 'UNAVAILABLE',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    };
    const actions = buildRecommendedActions(pnl, 'pos-1');
    expect(actions.some((a) => a.includes('Close'))).toBe(true);
    expect(actions.some((a) => a.includes('Monitor'))).toBe(true);
  });

  it('should always include monitor action', () => {
    const pnl = {
      closeNowEstimate: 'UNAVAILABLE',
      retryAtCurrentPrice: 'UNAVAILABLE',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    };
    const actions = buildRecommendedActions(pnl, 'pos-1');
    expect(actions.some((a) => a.includes('Monitor'))).toBe(true);
  });
});
