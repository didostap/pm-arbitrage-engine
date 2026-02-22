import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperTradingConnector } from './paper-trading.connector';
import { PaperTradingConfig } from './paper-trading.types';
import { createMockPlatformConnector } from '../../test/mock-factories';
import {
  PlatformId,
  PlatformHealth,
  OrderParams,
} from '../../common/types/platform.type';
import { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { NormalizedOrderBook } from '../../common/types/normalized-order-book.type';

describe('PaperTradingConnector', () => {
  let connector: PaperTradingConnector;
  let mockReal: ReturnType<typeof createMockPlatformConnector>;
  const config: PaperTradingConfig = {
    platformId: PlatformId.KALSHI,
    fillLatencyMs: 0, // no delay in tests
    slippageBps: 5,
  };

  beforeEach(() => {
    mockReal = createMockPlatformConnector(PlatformId.KALSHI);
    connector = new PaperTradingConnector(
      mockReal as unknown as IPlatformConnector,
      config,
    );
  });

  describe('data method delegation', () => {
    it('should delegate getOrderBook to real connector', async () => {
      const mockBook = { platformId: PlatformId.KALSHI } as NormalizedOrderBook;
      mockReal.getOrderBook.mockResolvedValue(mockBook);

      const result = await connector.getOrderBook('contract-1');

      expect(mockReal.getOrderBook).toHaveBeenCalledWith('contract-1');
      expect(result).toBe(mockBook);
    });

    it('should delegate getFeeSchedule to real connector', () => {
      connector.getFeeSchedule();
      expect(mockReal.getFeeSchedule).toHaveBeenCalled();
    });

    it('should delegate getPlatformId to real connector', () => {
      const result = connector.getPlatformId();
      expect(mockReal.getPlatformId).toHaveBeenCalled();
      expect(result).toBe(PlatformId.KALSHI);
    });

    it('should delegate onOrderBookUpdate to real connector', () => {
      const cb = vi.fn();
      connector.onOrderBookUpdate(cb);
      expect(mockReal.onOrderBookUpdate).toHaveBeenCalledWith(cb);
    });

    it('should delegate getPositions to real connector', async () => {
      mockReal.getPositions.mockResolvedValue([]);
      const result = await connector.getPositions();
      expect(mockReal.getPositions).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should delegate connect to real connector', async () => {
      mockReal.connect.mockResolvedValue(undefined);
      await connector.connect();
      expect(mockReal.connect).toHaveBeenCalled();
    });

    it('should delegate disconnect to real connector', async () => {
      mockReal.disconnect.mockResolvedValue(undefined);
      await connector.disconnect();
      expect(mockReal.disconnect).toHaveBeenCalled();
    });
  });

  describe('execution method interception', () => {
    const order: OrderParams = {
      contractId: 'contract-1',
      side: 'buy',
      quantity: 10,
      price: 0.55,
      type: 'limit',
    };

    it('should route submitOrder to fill simulator', async () => {
      const result = await connector.submitOrder(order);

      expect(result.status).toBe('filled');
      expect(result.platformId).toBe(PlatformId.KALSHI);
      expect(result.filledQuantity).toBe(order.quantity);
      expect(mockReal.submitOrder).not.toHaveBeenCalled();
    });

    it('should route cancelOrder to fill simulator', async () => {
      const fill = await connector.submitOrder(order);
      const cancel = await connector.cancelOrder(fill.orderId);

      expect(cancel.status).toBe('already_filled');
      expect(mockReal.cancelOrder).not.toHaveBeenCalled();
    });

    it('should route getOrder to fill simulator', async () => {
      const fill = await connector.submitOrder(order);
      const status = await connector.getOrder(fill.orderId);

      expect(status.orderId).toBe(fill.orderId);
      expect(status.status).toBe('filled');
      expect(mockReal.getOrder).not.toHaveBeenCalled();
    });
  });

  describe('getHealth', () => {
    it('should return real health with mode: paper added', () => {
      const realHealth: PlatformHealth = {
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
      };
      mockReal.getHealth.mockReturnValue(realHealth);

      const result = connector.getHealth();

      expect(result.platformId).toBe(PlatformId.KALSHI);
      expect(result.status).toBe('healthy');
      expect(result.mode).toBe('paper');
      expect(result.latencyMs).toBe(50);
    });
  });

  describe('getPlatformId', () => {
    it('should return underlying platform ID', () => {
      expect(connector.getPlatformId()).toBe(PlatformId.KALSHI);
    });
  });

  describe('per-platform isolation', () => {
    it('should maintain independent order maps across two instances', async () => {
      const mockPolymarket = createMockPlatformConnector(PlatformId.POLYMARKET);
      const polyConnector = new PaperTradingConnector(
        mockPolymarket as unknown as IPlatformConnector,
        {
          platformId: PlatformId.POLYMARKET,
          fillLatencyMs: 0,
          slippageBps: 15,
        },
      );

      const order: OrderParams = {
        contractId: 'c-1',
        side: 'buy',
        quantity: 1,
        price: 0.5,
        type: 'limit',
      };

      // Submit to Kalshi paper connector
      const kalshiFill = await connector.submitOrder(order);

      // Polymarket paper connector should not see it
      const polyOrder = await polyConnector.getOrder(kalshiFill.orderId);
      expect(polyOrder.status).toBe('not_found');

      // Kalshi paper connector should see it
      const kalshiOrder = await connector.getOrder(kalshiFill.orderId);
      expect(kalshiOrder.status).toBe('filled');
    });
  });
});
