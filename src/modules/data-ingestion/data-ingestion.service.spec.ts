/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataIngestionService } from './data-ingestion.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformHealthService } from './platform-health.service';
import { PrismaService } from '../../common/prisma.service';
import { PlatformId } from '../../common/types/platform.type';
import { OrderBookUpdatedEvent } from '../../common/events/orderbook.events';
import { vi } from 'vitest';

describe('DataIngestionService', () => {
  let service: DataIngestionService;

  const mockKalshiConnector = {
    onOrderBookUpdate: vi.fn(),
    getOrderBook: vi.fn(),
  };

  const mockNormalizer = {
    normalize: vi.fn(),
  };

  const mockHealthService = {
    recordUpdate: vi.fn(),
  };

  const mockPrismaService = {
    orderBookSnapshot: {
      create: vi.fn(),
    },
  };

  const mockEventEmitter = {
    emit: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataIngestionService,
        { provide: KalshiConnector, useValue: mockKalshiConnector },
        {
          provide: OrderBookNormalizerService,
          useValue: mockNormalizer,
        },
        { provide: PlatformHealthService, useValue: mockHealthService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<DataIngestionService>(DataIngestionService);

    // Clear mocks
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit()', () => {
    it('should register WebSocket callback', async () => {
      await service.onModuleInit();

      expect(mockKalshiConnector.onOrderBookUpdate).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });
  });

  describe('ingestCurrentOrderBooks()', () => {
    it('should fetch, normalize, persist and emit event', async () => {
      // Connector returns already normalized data
      const normalizedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST-MARKET',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockResolvedValue(normalizedBook);
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // Verify connector called
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalled();

      // Verify persistence
      expect(mockPrismaService.orderBookSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: 'KALSHI', // Uppercase to match DB enum
          contract_id: 'TEST-MARKET',
        }),
      });

      // Verify event emitted
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'orderbook.updated',
        expect.any(OrderBookUpdatedEvent),
      );

      // Verify health tracking
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.KALSHI,
        expect.any(Number),
      );
    });

    it('should handle connector errors gracefully', async () => {
      mockKalshiConnector.getOrderBook.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(service.ingestCurrentOrderBooks()).resolves.not.toThrow();
    });

    it('should handle normalization errors gracefully', async () => {
      const rawBook = { market_ticker: 'TEST', yes: [], no: [] };
      mockKalshiConnector.getOrderBook.mockResolvedValue(rawBook);
      mockNormalizer.normalize.mockImplementation(() => {
        throw new Error('Invalid data');
      });

      await expect(service.ingestCurrentOrderBooks()).resolves.not.toThrow();
    });
  });

  describe('processWebSocketUpdate()', () => {
    it('should persist and emit event for WebSocket update', async () => {
      // WebSocket receives already-normalized data from connector
      const normalizedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST-MARKET',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
        sequenceNumber: 12345,
      };

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service['processWebSocketUpdate'](normalizedBook);

      expect(mockPrismaService.orderBookSnapshot.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'orderbook.updated',
        expect.any(OrderBookUpdatedEvent),
      );
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.KALSHI,
        expect.any(Number),
      );
    });

    it('should throw on persistence error', async () => {
      const normalizedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(
        service['processWebSocketUpdate'](normalizedBook),
      ).rejects.toThrow('DB error');
    });
  });

  describe('persistSnapshot()', () => {
    it('should persist snapshot to database', async () => {
      const book = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST-MARKET',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
        sequenceNumber: 12345,
      };

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service['persistSnapshot'](book);

      expect(mockPrismaService.orderBookSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: 'KALSHI', // Uppercase to match DB enum
          contract_id: 'TEST-MARKET',
          sequence_number: 12345,
        }),
      });
    });

    it('should reset consecutive failures on success', async () => {
      const book = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      service['consecutiveFailures'] = 5;

      await service['persistSnapshot'](book);

      expect(service['consecutiveFailures']).toBe(0);
    });

    it('should track consecutive failures', async () => {
      const book = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockRejectedValue(
        new Error('DB error'),
      );

      service['consecutiveFailures'] = 0;

      await expect(service['persistSnapshot'](book)).rejects.toThrow();

      expect(service['consecutiveFailures']).toBe(1);
    });

    it('should emit critical alert after 10 consecutive failures', async () => {
      const book = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockRejectedValue(
        new Error('DB error'),
      );

      service['consecutiveFailures'] = 9;

      await expect(service['persistSnapshot'](book)).rejects.toThrow();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'system.health.critical',
        expect.objectContaining({
          code: 4005,
          severity: 'critical',
        }),
      );
    });

    it('should throw error on persistence failure', async () => {
      const book = {
        platformId: PlatformId.KALSHI,
        contractId: 'TEST',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(service['persistSnapshot'](book)).rejects.toThrow(
        'DB error',
      );
    });
  });
});
