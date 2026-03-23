/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary: Connector Isolation
 *
 * Verifies FillSimulator only produces 'filled' status,
 * paper fill config is per-platform, and PaperTradingConnector
 * mode cannot be swapped at runtime.
 *
 * TDD RED PHASE — all tests skip.
 */
import { describe, it, expect, vi } from 'vitest';
import { FillSimulatorService } from '../../../connectors/paper/fill-simulator.service';
import { PaperTradingConnector } from '../../../connectors/paper/paper-trading.connector';
import type { PaperTradingConfig } from '../../../connectors/paper/paper-trading.types';
import type { IPlatformConnector } from '../../interfaces/platform-connector.interface';
import { PlatformId } from '../../types/platform.type';
import type { OrderParams, OrderResult } from '../../types/platform.type';
import { asContractId } from '../../types/branded.type';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makeKalshiConfig(): PaperTradingConfig {
  return {
    platformId: PlatformId.KALSHI,
    fillLatencyMs: 0, // zero latency for test speed
    slippageBps: 5,
  };
}

function makePolymarketConfig(): PaperTradingConfig {
  return {
    platformId: PlatformId.POLYMARKET,
    fillLatencyMs: 0,
    slippageBps: 15,
  };
}

function makeSampleOrderParams(overrides?: Partial<OrderParams>): OrderParams {
  return {
    contractId: asContractId('contract-test-1'),
    side: 'buy',
    quantity: 10,
    price: 0.55,
    type: 'limit',
    ...overrides,
  };
}

function makeMockConnector(): IPlatformConnector {
  return {
    getOrderBook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getFeeSchedule: vi
      .fn()
      .mockReturnValue({ makerFeePct: 0, takerFeePct: 0.02 }),
    getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
    onOrderBookUpdate: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribeToContracts: vi.fn(),
    unsubscribeFromContracts: vi.fn(),
    getOrderBookFreshness: vi.fn().mockReturnValue({ lastWsUpdateAt: null }),
    submitOrder: vi.fn().mockResolvedValue({ status: 'filled' }),
    cancelOrder: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    getOrder: vi.fn().mockResolvedValue({ status: 'filled' }),
    getHealth: vi.fn().mockReturnValue({
      platformId: PlatformId.KALSHI,
      status: 'healthy',
      lastHeartbeat: new Date(),
      latencyMs: 50,
    }),
  } as unknown as IPlatformConnector;
}

describe('Paper/Live Boundary — Connectors', () => {
  describe('FillSimulatorService', () => {
    it('[P0] simulateFill() can ONLY produce status "filled" (never partial/rejected)', async () => {
      const config = makeKalshiConfig();
      const simulator = new FillSimulatorService(config);

      // Execute multiple fills with different params to probe for non-filled statuses
      const buyResult = await simulator.simulateFill(
        makeSampleOrderParams({ side: 'buy', price: 0.01 }),
      );
      const sellResult = await simulator.simulateFill(
        makeSampleOrderParams({ side: 'sell', price: 0.99 }),
      );
      const edgeResult = await simulator.simulateFill(
        makeSampleOrderParams({ price: 0.0001, quantity: 100000 }),
      );
      const minResult = await simulator.simulateFill(
        makeSampleOrderParams({ price: 1.0, quantity: 1 }),
      );

      // ALL results must be 'filled' — never 'partial', 'pending', or 'rejected'
      const allResults: OrderResult[] = [
        buyResult,
        sellResult,
        edgeResult,
        minResult,
      ];
      for (const result of allResults) {
        expect(result.status).toBe('filled');
        expect(result.status).not.toBe('partial');
        expect(result.status).not.toBe('rejected');
        expect(result.status).not.toBe('pending');
      }

      // filledQuantity should always equal requested quantity (no partial fills)
      expect(buyResult.filledQuantity).toBe(10);
      expect(edgeResult.filledQuantity).toBe(100000);
    });

    it('[P0] paper fill latency/slippage are configurable per-platform', async () => {
      const kalshiConfig = makeKalshiConfig();
      const polyConfig = makePolymarketConfig();

      const kalshiSim = new FillSimulatorService(kalshiConfig);
      const polySim = new FillSimulatorService(polyConfig);

      const params = makeSampleOrderParams({ side: 'buy', price: 0.5 });

      const kalshiResult = await kalshiSim.simulateFill(params);
      const polyResult = await polySim.simulateFill(params);

      // Different slippage configs should produce different fill prices
      // Kalshi: 5 bps slippage on buy = price * (1 + 5/10000) = 0.50 * 1.0005 = 0.50025
      // Polymarket: 15 bps slippage on buy = price * (1 + 15/10000) = 0.50 * 1.0015 = 0.50075
      expect(kalshiResult.filledPrice).not.toBe(polyResult.filledPrice);

      // Kalshi slippage should be less than Polymarket (5 bps < 15 bps)
      expect(kalshiResult.filledPrice).toBeLessThan(polyResult.filledPrice);

      // Verify exact slippage math for Kalshi buy: price * (1 + slippageBps/10000)
      const expectedKalshiPrice = 0.5 * (1 + 5 / 10000);
      expect(kalshiResult.filledPrice).toBeCloseTo(expectedKalshiPrice, 10);

      // Verify exact slippage math for Polymarket buy
      const expectedPolyPrice = 0.5 * (1 + 15 / 10000);
      expect(polyResult.filledPrice).toBeCloseTo(expectedPolyPrice, 10);
    });
  });

  describe('PaperTradingConnector', () => {
    it('[P0] mode immutability — wrapper cannot be swapped to live at runtime', async () => {
      const mockConnector = makeMockConnector();
      const config = makeKalshiConfig();
      const paperConnector = new PaperTradingConnector(mockConnector, config);

      // PaperTradingConnector always reports mode: 'paper' in health
      const health = paperConnector.getHealth();
      expect(health.mode).toBe('paper');

      // There is no setMode/switchMode/setLive method on PaperTradingConnector
      expect((paperConnector as any).setMode).toBeUndefined();
      expect((paperConnector as any).switchMode).toBeUndefined();
      expect((paperConnector as any).setLive).toBeUndefined();

      // Mode remains 'paper' across multiple getHealth() calls
      const health2 = paperConnector.getHealth();
      expect(health2.mode).toBe('paper');

      // submitOrder goes through fillSimulator, NOT real connector
      const orderParams = makeSampleOrderParams();
      await paperConnector.submitOrder(orderParams);
      expect(mockConnector.submitOrder).not.toHaveBeenCalled();
    });
  });
});
