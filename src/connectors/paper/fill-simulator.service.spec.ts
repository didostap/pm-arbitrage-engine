import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { FillSimulatorService } from './fill-simulator.service';
import { PaperTradingConfig, PAPER_MAX_ORDERS } from './paper-trading.types';
import { PlatformId, OrderParams } from '../../common/types/platform.type';

describe('FillSimulatorService', () => {
  let service: FillSimulatorService;
  const config: PaperTradingConfig = {
    platformId: PlatformId.KALSHI,
    fillLatencyMs: 100,
    slippageBps: 10, // 0.1%
  };

  const baseOrder: OrderParams = {
    contractId: 'contract-1',
    side: 'buy',
    quantity: 5,
    price: 0.55,
    type: 'limit',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    service = new FillSimulatorService(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('simulateFill', () => {
    it('should return valid OrderResult with correct platform/side/quantity', async () => {
      const promise = service.simulateFill(baseOrder);
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const result = await promise;

      expect(result.orderId).toBeDefined();
      expect(result.platformId).toBe(PlatformId.KALSHI);
      expect(result.status).toBe('filled');
      expect(result.filledQuantity).toBe(baseOrder.quantity);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should apply slippage correctly for buy (price increases)', async () => {
      const promise = service.simulateFill({
        ...baseOrder,
        side: 'buy',
        price: 0.5,
      });
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const result = await promise;

      // 0.5 * (1 + 10/10000) = 0.5 * 1.001 = 0.5005
      const expected = new Decimal('0.5').mul(
        new Decimal(1).plus(new Decimal(10).div(10000)),
      );
      expect(result.filledPrice).toBeCloseTo(expected.toNumber(), 10);
      expect(result.filledPrice).toBeGreaterThan(0.5);
    });

    it('should apply slippage correctly for sell (price decreases)', async () => {
      const promise = service.simulateFill({
        ...baseOrder,
        side: 'sell',
        price: 0.5,
      });
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const result = await promise;

      // 0.5 * (1 - 10/10000) = 0.5 * 0.999 = 0.4995
      const expected = new Decimal('0.5').mul(
        new Decimal(1).minus(new Decimal(10).div(10000)),
      );
      expect(result.filledPrice).toBeCloseTo(expected.toNumber(), 10);
      expect(result.filledPrice).toBeLessThan(0.5);
    });

    it('should use Decimal math with no floating-point drift', async () => {
      // 0.1 + 0.2 !== 0.3 in native JS. Verify precision-sensitive values.
      const svc = new FillSimulatorService({ ...config, slippageBps: 0 });
      const promise = svc.simulateFill({ ...baseOrder, price: 0.1 });
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const result = await promise;

      // With 0 slippage, filledPrice should be exactly the input price
      expect(result.filledPrice).toBe(0.1);
    });

    it('should simulate latency', async () => {
      let resolved = false;
      const promise = service.simulateFill(baseOrder).then((r) => {
        resolved = true;
        return r;
      });

      // Not resolved yet
      expect(resolved).toBe(false);

      // Advance past latency
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('getOrder', () => {
    it('should return stored order with fill data', async () => {
      const fillPromise = service.simulateFill(baseOrder);
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const fillResult = await fillPromise;

      const order = service.getOrder(fillResult.orderId);

      expect(order.orderId).toBe(fillResult.orderId);
      expect(order.status).toBe('filled');
      expect(order.fillPrice).toBe(fillResult.filledPrice);
      expect(order.fillSize).toBe(baseOrder.quantity);
    });

    it('should return not_found for unknown orderId', () => {
      const order = service.getOrder('unknown-id');

      expect(order.orderId).toBe('unknown-id');
      expect(order.status).toBe('not_found');
    });
  });

  describe('cancelOrder', () => {
    it('should return already_filled for filled order', async () => {
      const fillPromise = service.simulateFill(baseOrder);
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      const fillResult = await fillPromise;

      const cancel = service.cancelOrder(fillResult.orderId);

      expect(cancel.orderId).toBe(fillResult.orderId);
      expect(cancel.status).toBe('already_filled');
    });

    it('should return not_found for unknown orderId', () => {
      const cancel = service.cancelOrder('unknown-id');

      expect(cancel.orderId).toBe('unknown-id');
      expect(cancel.status).toBe('not_found');
    });
  });

  describe('getOrderCount', () => {
    it('should track order map size', async () => {
      expect(service.getOrderCount()).toBe(0);

      const p1 = service.simulateFill(baseOrder);
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      await p1;

      expect(service.getOrderCount()).toBe(1);

      const p2 = service.simulateFill(baseOrder);
      await vi.advanceTimersByTimeAsync(config.fillLatencyMs);
      await p2;

      expect(service.getOrderCount()).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when exceeding PAPER_MAX_ORDERS', async () => {
      // Use a small service to test eviction logic — we'll directly fill up to the limit
      const smallConfig: PaperTradingConfig = { ...config, fillLatencyMs: 0 };
      const svc = new FillSimulatorService(smallConfig);

      // Fill up to PAPER_MAX_ORDERS
      const firstOrderIds: string[] = [];
      for (let i = 0; i < PAPER_MAX_ORDERS; i++) {
        const result = await svc.simulateFill(baseOrder);
        if (i < 3) firstOrderIds.push(result.orderId);
      }

      expect(svc.getOrderCount()).toBe(PAPER_MAX_ORDERS);

      // Add one more — should evict the oldest
      await svc.simulateFill(baseOrder);

      expect(svc.getOrderCount()).toBe(PAPER_MAX_ORDERS);

      // First order should be evicted
      const evicted = svc.getOrder(firstOrderIds[0]!);
      expect(evicted.status).toBe('not_found');
    });
  });
});
