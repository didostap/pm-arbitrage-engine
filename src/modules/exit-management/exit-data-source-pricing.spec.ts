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

describe('ExitDataSourceService — pricing', () => {
  let service: ExitDataSourceService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;

  beforeEach(async () => {
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.66, quantity: 500 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      }),
    });
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.64, quantity: 500 }],
        timestamp: new Date(),
      }),
    });

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

  describe('getClosePrice', () => {
    it('should return best bid when original side is buy (selling to close)', async () => {
      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toEqual(new Decimal(0.66));
    });

    it('should return best ask when original side is sell (buying to close)', async () => {
      const price = await service.getClosePrice(
        PlatformId.POLYMARKET,
        asContractId('contract-1'),
        'sell',
      );
      expect(price).toEqual(new Decimal(0.64));
    });

    it('should return null when order book is empty on relevant side', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toBeNull();
    });
  });

  describe('VWAP-aware close pricing', () => {
    it('should return top-of-book when no positionSize provided (backward compat)', async () => {
      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toEqual(new Decimal(0.66));
    });

    it('should return VWAP across multiple levels for buy side close', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [
          { price: 0.66, quantity: 60 },
          { price: 0.64, quantity: 40 },
        ],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
        new Decimal(100),
      );

      // VWAP: (60 * 0.66 + 40 * 0.64) / 100 = (39.6 + 25.6) / 100 = 0.652
      expect(price!.toNumber()).toBeCloseTo(0.652, 6);
    });

    it('should return VWAP of available depth when book cannot fill full position', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [{ price: 0.66, quantity: 50 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
        new Decimal(200),
      );

      // Only 50 available: VWAP = 0.66 (single level)
      expect(price!.toNumber()).toBeCloseTo(0.66, 6);
    });

    it('should return null when book has no levels on close side', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        PlatformId.KALSHI,
        asContractId('contract-1'),
        'buy',
        new Decimal(100),
      );

      expect(price).toBeNull();
    });

    it('should compute VWAP for sell side close (using asks)', async () => {
      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('contract-1'),
        bids: [{ price: 0.6, quantity: 500 }],
        asks: [
          { price: 0.64, quantity: 30 },
          { price: 0.66, quantity: 70 },
        ],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        PlatformId.POLYMARKET,
        asContractId('contract-1'),
        'sell',
        new Decimal(100),
      );

      // VWAP: (30 * 0.64 + 70 * 0.66) / 100 = (19.2 + 46.2) / 100 = 0.654
      expect(price!.toNumber()).toBeCloseTo(0.654, 6);
    });
  });
});
