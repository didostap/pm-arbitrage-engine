// eslint-disable -- dynamic imports + `any`-typed mocks require broad unsafe-* suppression
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { PlatformId } from '../../../common/types/platform.type';
import type { ContractId } from '../../../common/types/branded.type';
import { PrismaService } from '../../../common/prisma.service';

describe('FillModelService', () => {
  let service: any;
  let prismaService: PrismaService;

  beforeEach(async () => {
    prismaService = {
      historicalDepth: {
        findFirst: vi.fn(),
      },
    };

    const { FillModelService } = await import('./fill-model.service');
    const module = await Test.createTestingModule({
      providers: [
        FillModelService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get(FillModelService);
  });

  // ============================================================
  // adaptDepthToOrderBook() — 4 tests
  // ============================================================

  describe('adaptDepthToOrderBook()', () => {
    it('[P0] should convert NormalizedHistoricalDepth to NormalizedOrderBook', () => {
      const depth = {
        platform: 'kalshi',
        contractId: 'KXBTC-24DEC31',
        source: 'PMXT_ARCHIVE',
        bids: [
          { price: 0.45, size: 100 },
          { price: 0.44, size: 200 },
        ],
        asks: [
          { price: 0.46, size: 150 },
          { price: 0.47, size: 250 },
        ],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot' as const,
      };

      const orderBook = service.adaptDepthToOrderBook(depth, PlatformId.KALSHI);

      expect(orderBook.platformId).toBe(PlatformId.KALSHI);
      expect(orderBook.contractId).toBe('KXBTC-24DEC31');
      expect(orderBook.bids).toHaveLength(2);
      expect(orderBook.asks).toHaveLength(2);
      expect(typeof orderBook.bids[0].price).toBe('number');
      expect(typeof orderBook.bids[0].quantity).toBe('number');
      expect(orderBook.bids[0].price).toBeCloseTo(0.45);
      expect(orderBook.asks[0].price).toBeCloseTo(0.46);
    });

    it('[P0] should sort bids descending by price and asks ascending by price', () => {
      const depth = {
        platform: 'kalshi',
        contractId: 'KXBTC-24DEC31',
        source: 'PMXT_ARCHIVE',
        bids: [
          { price: 0.4, size: 100 },
          { price: 0.45, size: 200 },
          { price: 0.42, size: 150 },
        ],
        asks: [
          { price: 0.5, size: 100 },
          { price: 0.46, size: 200 },
          { price: 0.48, size: 150 },
        ],
        timestamp: new Date(),
        updateType: 'snapshot' as const,
      };

      const orderBook = service.adaptDepthToOrderBook(depth, PlatformId.KALSHI);

      // Bids: descending
      expect(orderBook.bids[0].price).toBeCloseTo(0.45);
      expect(orderBook.bids[1].price).toBeCloseTo(0.42);
      expect(orderBook.bids[2].price).toBeCloseTo(0.4);
      // Asks: ascending
      expect(orderBook.asks[0].price).toBeCloseTo(0.46);
      expect(orderBook.asks[1].price).toBeCloseTo(0.48);
      expect(orderBook.asks[2].price).toBeCloseTo(0.5);
    });

    it('[P1] should preserve platformId and contractId in converted order book', () => {
      const depth = {
        platform: 'polymarket',
        contractId: '0xABC123',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: 0.5, size: 100 }],
        asks: [{ price: 0.51, size: 100 }],
        timestamp: new Date(),
        updateType: 'snapshot' as const,
      };

      const orderBook = service.adaptDepthToOrderBook(
        depth,
        PlatformId.POLYMARKET,
      );

      expect(orderBook.platformId).toBe(PlatformId.POLYMARKET);
      expect(orderBook.contractId).toBe('0xABC123');
      expect(orderBook.timestamp).toBe(depth.timestamp);
    });

    it('[P1] should handle empty bids or asks arrays without error', () => {
      const depth = {
        platform: 'kalshi',
        contractId: 'KXBTC-24DEC31',
        source: 'PMXT_ARCHIVE',
        bids: [],
        asks: [],
        timestamp: new Date(),
        updateType: 'snapshot' as const,
      };

      const orderBook = service.adaptDepthToOrderBook(depth, PlatformId.KALSHI);

      expect(orderBook.bids).toHaveLength(0);
      expect(orderBook.asks).toHaveLength(0);
    });
  });

  // ============================================================
  // findNearestDepth() — 4 tests
  // ============================================================

  describe('findNearestDepth()', () => {
    it('[P0] should return the most recent depth snapshot with timestamp <= query timestamp', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'KXBTC-24DEC31',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.45', size: '100' }],
        asks: [{ price: '0.46', size: '150' }],
        timestamp: new Date('2025-02-01T13:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      const result = await service.findNearestDepth(
        'KALSHI',
        'KXBTC-24DEC31',
        new Date('2025-02-01T13:30:00Z'),
      );

      expect(result).not.toBeNull();
      expect(result!.contractId).toBe('KXBTC-24DEC31');
      expect(result!.bids).toHaveLength(1);
      expect(typeof result!.bids[0].price).toBe('number');
      expect(result!.bids[0].price).toBe(0.45);

      expect(prismaService.historicalDepth.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            platform: 'KALSHI',
            contractId: 'KXBTC-24DEC31',
          }),
          orderBy: { timestamp: 'desc' },
        }),
      );
    });

    it('[P0] should return null when no depth snapshot exists at or before query timestamp', async () => {
      prismaService.historicalDepth.findFirst.mockResolvedValue(null);

      const result = await service.findNearestDepth(
        'KALSHI',
        'KXBTC-24DEC31',
        new Date('2025-01-01T00:00:00Z'),
      );

      expect(result).toBeNull();
    });

    it('[P1] should select correct snapshot when multiple exist (use nearest, not interpolated)', async () => {
      const snapshot = {
        id: 2,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.50', size: '200' }],
        asks: [{ price: '0.51', size: '200' }],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(snapshot);

      const result = await service.findNearestDepth(
        'KALSHI',
        'K-1',
        new Date('2025-02-01T14:45:00Z'),
      );

      expect(result).not.toBeNull();
      // Verifies nearest-neighbor (earlier snapshot), not interpolation
      expect(result!.timestamp).toEqual(new Date('2025-02-01T14:00:00Z'));
    });

    it('[P1] should filter by platform and contractId when querying depth', async () => {
      prismaService.historicalDepth.findFirst.mockResolvedValue(null);

      await service.findNearestDepth(
        'POLYMARKET',
        'poly-xyz',
        new Date('2025-02-01T14:00:00Z'),
      );

      expect(prismaService.historicalDepth.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            platform: 'POLYMARKET',
            contractId: 'poly-xyz',
          }),
        }),
      );
    });
  });

  // ============================================================
  // modelFill() — 6 tests
  // ============================================================

  describe('modelFill()', () => {
    it('[P0] should return VwapFillResult when sufficient depth available', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [
          { price: '0.45', size: '500' },
          { price: '0.44', size: '500' },
        ],
        asks: [
          { price: '0.46', size: '500' },
          { price: '0.47', size: '500' },
        ],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
      );

      expect(result).not.toBeNull();
      expect(result!.vwap).toBeInstanceOf(Decimal);
      expect(result!.filledQty).toBeInstanceOf(Decimal);
      expect(result!.filledQty.gte(new Decimal('100'))).toBe(true);
    });

    it('[P0] should return null when depth is insufficient for requested position size', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [],
        asks: [],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
      );

      expect(result).toBeNull();
    });

    it('[P0] should return partial fill proportional to available depth', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.45', size: '50' }],
        asks: [{ price: '0.46', size: '50' }],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('200'),
      );

      // Should get partial fill (50 from available depth)
      expect(result).not.toBeNull();
      expect(result!.filledQty.lte(new Decimal('50'))).toBe(true);
    });

    it('[P1] should use taker side (ask for buys, bid for sells)', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.45', size: '500' }],
        asks: [{ price: '0.55', size: '500' }],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      // Buy order = take from asks
      const buyResult = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
      );

      // Sell order = take from bids
      const sellResult = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'sell',
        new Decimal('100'),
      );

      expect(buyResult).not.toBeNull();
      expect(sellResult).not.toBeNull();
      // Buy takes from asks (higher price), sell from bids (lower price)
      expect(buyResult!.vwap.gt(sellResult!.vwap)).toBe(true);
    });

    it('[P1] should return null when nearest depth snapshot not found', async () => {
      prismaService.historicalDepth.findFirst.mockResolvedValue(null);

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
      );

      expect(result).toBeNull();
    });

    // 10-9-3a ATDD: INT-010
    it('[P0] when depthCache is provided, uses findNearestDepthFromCache — no prisma findFirst calls', async () => {
      const data = new Map<string, any[]>();
      data.set('KALSHI:K-1', [
        {
          platform: 'KALSHI',
          contractId: 'K-1',
          source: 'PMXT_ARCHIVE',
          bids: [{ price: 0.45, size: 500 }],
          asks: [{ price: 0.46, size: 500 }],
          timestamp: new Date('2025-02-01T14:00:00Z'),
          updateType: 'snapshot',
        },
      ]);
      const depthCache = { kind: 'eager' as const, data };

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
        depthCache,
      );

      expect(result).not.toBeNull();
      expect(prismaService.historicalDepth.findFirst).not.toHaveBeenCalled();
    });

    // 10-9-3a ATDD: INT-011
    it('[P0] when depthCache is NOT provided, falls back to existing findNearestDepth() DB query', async () => {
      prismaService.historicalDepth.findFirst.mockResolvedValue({
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.45', size: '500' }],
        asks: [{ price: '0.46', size: '500' }],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      });

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
      );

      expect(result).not.toBeNull();
      expect(prismaService.historicalDepth.findFirst).toHaveBeenCalledTimes(1);
    });

    // 10-9-3a ATDD: INT-012
    it('[P1] cache miss (no depth for contract) returns null gracefully', async () => {
      const depthCache = {
        kind: 'eager' as const,
        data: new Map<string, any[]>(),
      };

      const result = await service.modelFill(
        'KALSHI',
        'K-UNKNOWN' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'buy',
        new Decimal('100'),
        depthCache,
      );

      expect(result).toBeNull();
      expect(prismaService.historicalDepth.findFirst).not.toHaveBeenCalled();
    });

    // 10-9-3a ATDD: INT-013
    it('[P1] FillModelService constructor dep count stays at 1 (PrismaService)', async () => {
      const { FillModelService } = await import('./fill-model.service');
      // Constructor takes only PrismaService (1 dep)
      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        FillModelService,
      );
      expect(paramTypes).toHaveLength(1);
    });

    it('[P1] should correctly parse Prisma Json depth levels (string price/size → Decimal)', async () => {
      const depthRecord = {
        id: 1,
        platform: 'KALSHI',
        contractId: 'K-1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.4500', size: '100.50' }],
        asks: [{ price: '0.4600', size: '200.75' }],
        timestamp: new Date('2025-02-01T14:00:00Z'),
        updateType: 'snapshot',
      };
      prismaService.historicalDepth.findFirst.mockResolvedValue(depthRecord);

      const result = await service.modelFill(
        'KALSHI',
        'K-1' as ContractId,
        PlatformId.KALSHI,
        new Date('2025-02-01T14:30:00Z'),
        'sell',
        new Decimal('50'),
      );

      expect(result).not.toBeNull();
      // If parsing works, the fill should succeed with correct Decimal precision
      expect(result!.vwap.toFixed(4)).toBe('0.4500');
    });
  });
});
