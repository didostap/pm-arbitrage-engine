import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { DataQualityService } from './data-quality.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  NormalizedPrice,
  NormalizedTrade,
} from '../types/normalized-historical.types';

function createDataQualityService(mockEmitter?: any) {
  const emitter = mockEmitter ?? new EventEmitter2();
  return new DataQualityService(emitter);
}

function createNormalizedPrice(
  overrides: Record<string, any> = {},
): NormalizedPrice {
  return {
    platform: 'kalshi',
    contractId: 'KXBTC-24DEC31',
    source: 'KALSHI_API' as any,
    intervalMinutes: 1,
    timestamp: new Date('2025-01-01T00:00:00Z'),
    open: new Decimal('0.50'),
    high: new Decimal('0.52'),
    low: new Decimal('0.48'),
    close: new Decimal('0.51'),
    volume: new Decimal('1000'),
    openInterest: null,
    ...overrides,
  };
}

function createNormalizedTrade(
  overrides: Record<string, any> = {},
): NormalizedTrade {
  return {
    platform: 'kalshi',
    contractId: 'KXBTC-24DEC31',
    source: 'KALSHI_API' as any,
    externalTradeId: `trade-${Math.random().toString(36).slice(2)}`,
    price: new Decimal('0.50'),
    size: new Decimal('25.00'),
    side: 'buy',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('DataQualityService', () => {
  describe('assessPriceQuality', () => {
    it('[P1] should detect coverage gaps when missing expected timestamps', () => {
      const service = createDataQualityService();

      // 5 candles with a 10-minute gap (threshold = 5× 1-min interval = 5 min)
      const prices = [
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:00:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:01:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:02:00Z') }),
        // Gap: 10 minutes (exceeds 5× threshold)
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:12:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:13:00Z') }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasGaps).toBe(true);
      expect(flags.gapDetails.length).toBeGreaterThan(0);
    });

    it('[P1] should detect suspicious price jumps exceeding 20%', () => {
      const service = createDataQualityService();

      const prices = [
        createNormalizedPrice({
          close: new Decimal('0.50'),
          timestamp: new Date('2025-01-01T00:00:00Z'),
        }),
        createNormalizedPrice({
          close: new Decimal('0.51'),
          timestamp: new Date('2025-01-01T00:01:00Z'),
        }),
        // >20% jump: 0.51 → 0.65
        createNormalizedPrice({
          close: new Decimal('0.65'),
          timestamp: new Date('2025-01-01T00:02:00Z'),
        }),
        createNormalizedPrice({
          close: new Decimal('0.64'),
          timestamp: new Date('2025-01-01T00:03:00Z'),
        }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasSuspiciousJumps).toBe(true);
      expect(flags.jumpDetails.length).toBeGreaterThan(0);
    });

    it('[P1] should detect stale data when latest timestamp >24h behind expected', () => {
      const service = createDataQualityService();

      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const prices = [createNormalizedPrice({ timestamp: twoDaysAgo })];

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasStaleData).toBe(true);
    });

    it('[P1] should detect low volume when all candles have zero volume', () => {
      const service = createDataQualityService();

      const prices = [
        createNormalizedPrice({
          volume: null,
          timestamp: new Date('2025-01-01T00:00:00Z'),
        }),
        createNormalizedPrice({
          volume: null,
          timestamp: new Date('2025-01-01T00:01:00Z'),
        }),
        createNormalizedPrice({
          volume: null,
          timestamp: new Date('2025-01-01T00:02:00Z'),
        }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasLowVolume).toBe(true);
    });

    it('[P1] should return no flags for clean data', () => {
      const service = createDataQualityService();

      const now = new Date();
      const prices = Array.from({ length: 10 }, (_, i) =>
        createNormalizedPrice({
          close: new Decimal('0.50'),
          volume: new Decimal('1000'),
          timestamp: new Date(now.getTime() - (9 - i) * 60000),
        }),
      );

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasGaps).toBe(false);
      expect(flags.hasSuspiciousJumps).toBe(false);
      expect(flags.hasStaleData).toBe(false);
      expect(flags.hasLowVolume).toBe(false);
    });

    it('[P1] should handle exactly-at-threshold price jump (20%) without flagging', () => {
      const service = createDataQualityService();

      const prices = [
        createNormalizedPrice({
          close: new Decimal('0.50'),
          timestamp: new Date('2025-01-01T00:00:00Z'),
        }),
        // Exactly 20% jump: 0.50 → 0.60 (should NOT flag — threshold is >20%)
        createNormalizedPrice({
          close: new Decimal('0.60'),
          timestamp: new Date('2025-01-01T00:01:00Z'),
        }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      expect(flags.hasSuspiciousJumps).toBe(false);
    });

    it('[P14] should sort unsorted prices by timestamp before analysis', () => {
      const service = createDataQualityService();

      // Reverse chronological order — should still detect gaps correctly
      const prices = [
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:13:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:00:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:12:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:01:00Z') }),
        createNormalizedPrice({ timestamp: new Date('2025-01-01T00:02:00Z') }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      // Gap between 00:02 and 00:12 should be detected even with unsorted input
      expect(flags.hasGaps).toBe(true);
    });

    it('[P15] should use Decimal arithmetic for price jump calculation', () => {
      const service = createDataQualityService();

      // Use values where float math would give different results
      const prices = [
        createNormalizedPrice({
          close: new Decimal('0.3'),
          timestamp: new Date('2025-01-01T00:00:00Z'),
        }),
        createNormalizedPrice({
          close: new Decimal('0.3630000000000001'),
          timestamp: new Date('2025-01-01T00:01:00Z'),
        }),
      ];

      const flags = service.assessPriceQuality(prices, 1);
      // 21% jump — Decimal correctly computes this as >20%
      expect(flags.hasSuspiciousJumps).toBe(true);
    });
  });

  describe('assessTradeQuality', () => {
    it('[P1] should detect gaps in trade data', () => {
      const service = createDataQualityService();

      const trades = [
        createNormalizedTrade({ timestamp: new Date('2025-01-01T00:00:00Z') }),
        // Gap: 2 hours with no trades
        createNormalizedTrade({ timestamp: new Date('2025-01-01T02:00:00Z') }),
      ];

      const flags = service.assessTradeQuality(trades);
      expect(flags.hasGaps).toBe(true);
    });

    it('[P1] should detect low volume (< 5 trades in a 1-hour window)', () => {
      const service = createDataQualityService();

      const trades = [
        createNormalizedTrade({ timestamp: new Date('2025-01-01T00:00:00Z') }),
        createNormalizedTrade({ timestamp: new Date('2025-01-01T00:15:00Z') }),
        createNormalizedTrade({ timestamp: new Date('2025-01-01T00:30:00Z') }),
        // Only 3 trades in 1 hour
      ];

      const flags = service.assessTradeQuality(trades);
      expect(flags.hasLowVolume).toBe(true);
    });

    it('[P21] should not false-flag when trades fit within a single 1-hour window', () => {
      const service = createDataQualityService();

      // 5 trades within 59 minutes — all fit in one window [00:00, 01:00)
      const trades = Array.from({ length: 5 }, (_, i) =>
        createNormalizedTrade({
          timestamp: new Date(
            new Date('2025-01-01T00:00:00Z').getTime() + i * 12 * 60 * 1000,
          ),
        }),
      );

      const flags = service.assessTradeQuality(trades);
      // 5 trades in [00:00, 00:48] — all within the first 1-hour window
      expect(flags.hasLowVolume).toBe(false);
    });

    it('[P14] should sort unsorted trades before analysis', () => {
      const service = createDataQualityService();

      // Out of order trades — gap between 00:00 and 02:00 should still be detected
      const trades = [
        createNormalizedTrade({ timestamp: new Date('2025-01-01T02:00:00Z') }),
        createNormalizedTrade({ timestamp: new Date('2025-01-01T00:00:00Z') }),
      ];

      const flags = service.assessTradeQuality(trades);
      expect(flags.hasGaps).toBe(true);
    });
  });

  describe('assessSurvivorshipBias', () => {
    it('[P1] should flag resolved contracts (survivorship bias)', () => {
      const service = createDataQualityService();

      const match = {
        operatorApproved: true,
        resolutionTimestamp: new Date('2025-02-15'),
      };

      const flags = service.assessSurvivorshipBias('contract-1', match as any);
      expect(flags.hasSurvivorshipBias).toBe(true);
    });

    it('[P1] should flag unapproved matches', () => {
      const service = createDataQualityService();

      const match = {
        operatorApproved: false,
        resolutionTimestamp: null,
      };

      const flags = service.assessSurvivorshipBias('contract-2', match as any);
      expect(flags.hasSurvivorshipBias).toBe(true);
    });
  });

  describe('event emission', () => {
    it('[P1] should emit BacktestDataQualityWarningEvent when quality flags are present', () => {
      const mockEmitter = { emit: vi.fn() };
      const service = createDataQualityService(mockEmitter);

      const flags = {
        hasGaps: true,
        hasSuspiciousJumps: false,
        hasSurvivorshipBias: false,
        hasStaleData: false,
        hasLowVolume: false,
        gapDetails: [{ from: new Date(), to: new Date() }],
        jumpDetails: [],
      };

      service.emitQualityWarning(
        'KALSHI_API',
        'kalshi',
        'contract-1',
        flags,
        'test-corr',
      );

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        'backtesting.data.quality-warning',
        expect.objectContaining({
          source: 'KALSHI_API',
          platform: 'kalshi',
          contractId: 'contract-1',
          correlationId: 'test-corr',
        }),
      );
    });
  });
});
