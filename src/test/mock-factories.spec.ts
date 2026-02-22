/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from 'vitest';
import { PlatformId } from '../common/types/platform.type.js';
import {
  createMockPlatformConnector,
  createMockRiskManager,
  createMockExecutionEngine,
} from './mock-factories.js';

describe('Mock Factories', () => {
  describe('createMockPlatformConnector', () => {
    it('should return all 11 IPlatformConnector methods', () => {
      const mock = createMockPlatformConnector();
      const expectedMethods = [
        'connect',
        'disconnect',
        'getPlatformId',
        'getHealth',
        'getOrderBook',
        'submitOrder',
        'cancelOrder',
        'getOrder',
        'getPositions',
        'getFeeSchedule',
        'onOrderBookUpdate',
      ];

      for (const method of expectedMethods) {
        expect(mock).toHaveProperty(method);
        expect(typeof mock[method as keyof typeof mock]).toBe('function');
      }
    });

    it('should default to KALSHI platform', () => {
      const mock = createMockPlatformConnector();
      expect(mock.getPlatformId()).toBe(PlatformId.KALSHI);
    });

    it('should accept platformId parameter', () => {
      const mock = createMockPlatformConnector(PlatformId.POLYMARKET);
      expect(mock.getPlatformId()).toBe(PlatformId.POLYMARKET);
      expect(mock.getFeeSchedule().takerFeePercent).toBe(2);
    });

    it('should apply overrides', () => {
      const customFn = vi.fn().mockReturnValue('custom');
      const mock = createMockPlatformConnector(PlatformId.KALSHI, {
        getHealth: customFn,
      });
      expect(mock.getHealth()).toBe('custom');
    });

    it('should return fresh mocks on each call (test isolation)', () => {
      const mock1 = createMockPlatformConnector();
      const mock2 = createMockPlatformConnector();
      expect(mock1.submitOrder).not.toBe(mock2.submitOrder);
    });

    it('should have sensible defaults for getHealth', () => {
      const mock = createMockPlatformConnector(PlatformId.KALSHI);
      const health = mock.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.platformId).toBe(PlatformId.KALSHI);
    });

    it('should have Kalshi fees (0% taker) by default', () => {
      const mock = createMockPlatformConnector(PlatformId.KALSHI);
      const fees = mock.getFeeSchedule();
      expect(fees.takerFeePercent).toBe(0);
    });

    it('should have Polymarket fees (2% taker) when specified', () => {
      const mock = createMockPlatformConnector(PlatformId.POLYMARKET);
      const fees = mock.getFeeSchedule();
      expect(fees.takerFeePercent).toBe(2);
    });
  });

  describe('createMockRiskManager', () => {
    it('should return all 13 IRiskManager methods', () => {
      const mock = createMockRiskManager();
      const expectedMethods = [
        'validatePosition',
        'getCurrentExposure',
        'getOpenPositionCount',
        'updateDailyPnl',
        'isTradingHalted',
        'haltTrading',
        'resumeTrading',
        'recalculateFromPositions',
        'processOverride',
        'reserveBudget',
        'commitReservation',
        'releaseReservation',
        'closePosition',
      ];

      for (const method of expectedMethods) {
        expect(mock).toHaveProperty(method);
        expect(typeof mock[method as keyof typeof mock]).toBe('function');
      }
    });

    it('should default isTradingHalted to false', () => {
      const mock = createMockRiskManager();
      expect(mock.isTradingHalted()).toBe(false);
    });

    it('should default validatePosition to approved', async () => {
      const mock = createMockRiskManager();
      const result = await mock.validatePosition();
      expect(result.approved).toBe(true);
    });

    it('should apply overrides', () => {
      const mock = createMockRiskManager({
        isTradingHalted: vi.fn().mockReturnValue(true),
      });
      expect(mock.isTradingHalted()).toBe(true);
    });

    it('should return fresh mocks on each call', () => {
      const mock1 = createMockRiskManager();
      const mock2 = createMockRiskManager();
      expect(mock1.validatePosition).not.toBe(mock2.validatePosition);
    });
  });

  describe('createMockExecutionEngine', () => {
    it('should return execute method', () => {
      const mock = createMockExecutionEngine();
      expect(mock).toHaveProperty('execute');
      expect(typeof mock.execute).toBe('function');
    });

    it('should default to failed result', async () => {
      const mock = createMockExecutionEngine();
      const result = await mock.execute();
      expect(result.success).toBe(false);
    });

    it('should apply overrides', () => {
      const customExecute = vi.fn().mockResolvedValue({ success: true });
      const mock = createMockExecutionEngine({ execute: customExecute });
      expect(mock.execute).toBe(customExecute);
    });

    it('should return fresh mocks on each call', () => {
      const mock1 = createMockExecutionEngine();
      const mock2 = createMockExecutionEngine();
      expect(mock1.execute).not.toBe(mock2.execute);
    });
  });
});
