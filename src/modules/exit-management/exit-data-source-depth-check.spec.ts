import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { ExitDataSourceService } from './exit-data-source.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { PlatformId } from '../../common/types/platform.type';
import { asContractId } from '../../common/types/branded.type';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

describe('ExitDataSourceService — depth check', () => {
  let service: ExitDataSourceService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;

  beforeEach(async () => {
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET);

    const module = await Test.createTestingModule({
      providers: [
        ExitDataSourceService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        {
          provide: ConfigService,
          useValue: {
            get: vi
              .fn()
              .mockImplementation(
                (_key: string, defaultVal: unknown) => defaultVal,
              ),
          },
        },
      ],
    }).compile();

    service = module.get(ExitDataSourceService);
  });

  describe('tolerance band', () => {
    it('buy-close with 2% tolerance includes ask levels within band', async () => {
      // closePrice = 0.50, 2% band → cutoff = 0.51
      // Asks at 0.50 (qty 1) and 0.505 (qty 10) both <= 0.51 → included
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.5, quantity: 1 },
          { price: 0.505, quantity: 10 },
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      expect(depth).toEqual(new Decimal(11));
    });

    it('sell-close with 2% tolerance includes bid levels within band', async () => {
      // closePrice = 0.60, 2% band → cutoff = 0.60 × 0.98 = 0.588
      // Bids at 0.60 (qty 5) and 0.59 (qty 8) both >= 0.588 → included
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [
          { price: 0.6, quantity: 5 },
          { price: 0.59, quantity: 8 },
        ],
        asks: [],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'sell',
        new Decimal('0.60'),
      );

      expect(depth).toEqual(new Decimal(13));
    });

    it('levels beyond the tolerance band are excluded', async () => {
      // closePrice = 0.50, 2% band → cutoff = 0.51
      // Ask at 0.52 > 0.51 → excluded
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.5, quantity: 1 },
          { price: 0.505, quantity: 10 },
          { price: 0.52, quantity: 20 },
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      // Only 0.50 (1) + 0.505 (10) = 11, 0.52 excluded
      expect(depth).toEqual(new Decimal(11));
    });

    it('tolerance=0.0 restores strict-VWAP behavior', async () => {
      // closePrice = 0.50, tolerance = 0 → cutoff = 0.50 × 1.0 = 0.50
      // Only ask at exactly 0.50 (qty 1) passes
      service.reloadConfig({ exitDepthSlippageTolerance: 0.0 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.5, quantity: 1 },
          { price: 0.505, quantity: 10 },
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      expect(depth).toEqual(new Decimal(1));
    });

    it('empty order book returns zero depth', async () => {
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      expect(depth).toEqual(new Decimal(0));
    });

    it('all levels within band accumulates total depth correctly', async () => {
      // closePrice = 0.50, 2% band → cutoff = 0.51
      // 3 levels all within band
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.49, quantity: 3 },
          { price: 0.5, quantity: 7 },
          { price: 0.508, quantity: 15 },
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      expect(depth).toEqual(new Decimal(25));
    });

    it('excludes levels with zero or negative quantity', async () => {
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.49, quantity: 3 },
          { price: 0.5, quantity: 0 },
          { price: 0.505, quantity: -1 },
          { price: 0.508, quantity: 7 },
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      // Only qty 3 + qty 7 = 10; zero and negative excluded
      expect(depth).toEqual(new Decimal(10));
    });

    it('hot-reload updates exitDepthSlippageTolerance', () => {
      service.reloadConfig({ exitDepthSlippageTolerance: 0.05 });
      expect(
        (service as Record<string, unknown>)['exitDepthSlippageTolerance'],
      ).toBe(0.05);
    });
  });

  describe('D4: unsorted order book levels', () => {
    it('should compute correct depth when ask levels are unsorted', async () => {
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      // Asks in WRONG order (out-of-band first, then in-band)
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [
          { price: 0.52, quantity: 20 }, // beyond band (cutoff=0.51)
          { price: 0.505, quantity: 10 }, // within band
          { price: 0.5, quantity: 1 }, // within band
        ],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'buy',
        new Decimal('0.50'),
      );

      // Defensive sort: 0.50(1) + 0.505(10) = 11. 0.52 is beyond cutoff 0.51.
      expect(depth).toEqual(new Decimal(11));
    });

    it('should compute correct depth when bid levels are unsorted', async () => {
      service.reloadConfig({ exitDepthSlippageTolerance: 0.02 });
      // Bids in WRONG order (low first, then high)
      kalshiConnector.getOrderBook.mockResolvedValueOnce({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [
          { price: 0.55, quantity: 5 }, // below cutoff (0.588)
          { price: 0.6, quantity: 5 }, // within band
          { price: 0.59, quantity: 8 }, // within band
        ],
        asks: [],
        timestamp: new Date(),
      });

      const depth = await service.getAvailableExitDepth(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        'sell',
        new Decimal('0.60'),
      );

      // Defensive sort descending: 0.60(5) + 0.59(8) = 13. 0.55 < cutoff 0.588.
      expect(depth).toEqual(new Decimal(13));
    });
  });
});
