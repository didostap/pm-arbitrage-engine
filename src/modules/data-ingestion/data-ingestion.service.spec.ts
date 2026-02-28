/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataIngestionService } from './data-ingestion.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformHealthService } from './platform-health.service';
import { PrismaService } from '../../common/prisma.service';
import { SystemHealthError } from '../../common/errors/system-health-error';
import { PlatformId } from '../../common/types/platform.type';
import { OrderBookUpdatedEvent } from '../../common/events/orderbook.events';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';
import { ContractPairConfig } from '../contract-matching/types/contract-pair-config.type';
import { vi } from 'vitest';
import { DegradationProtocolService } from './degradation-protocol.service';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

const TEST_PAIRS: ContractPairConfig[] = [
  {
    kalshiContractId: 'KALSHI-TICKER-1',
    polymarketContractId: 'pm-token-1',
    eventDescription: 'Test event 1',
    operatorVerificationTimestamp: new Date('2026-02-27T00:00:00Z'),
    primaryLeg: 'kalshi',
  },
  {
    kalshiContractId: 'KALSHI-TICKER-2',
    polymarketContractId: 'pm-token-2',
    eventDescription: 'Test event 2',
    operatorVerificationTimestamp: new Date('2026-02-27T00:00:00Z'),
    primaryLeg: 'polymarket',
  },
];

describe('DataIngestionService', () => {
  let service: DataIngestionService;

  const mockKalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);

  const mockPolymarketConnector = createMockPlatformConnector(
    PlatformId.POLYMARKET,
  );

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

  const mockDegradationService = {
    isDegraded: vi.fn().mockReturnValue(false),
    activateProtocol: vi.fn(),
    deactivateProtocol: vi.fn(),
    incrementPollingCycle: vi.fn(),
  };

  const mockContractPairLoader = {
    getActivePairs: vi.fn().mockReturnValue(TEST_PAIRS),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataIngestionService,
        { provide: KalshiConnector, useValue: mockKalshiConnector },
        { provide: PolymarketConnector, useValue: mockPolymarketConnector },
        {
          provide: OrderBookNormalizerService,
          useValue: mockNormalizer,
        },
        { provide: PlatformHealthService, useValue: mockHealthService },
        {
          provide: DegradationProtocolService,
          useValue: mockDegradationService,
        },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        {
          provide: ContractPairLoaderService,
          useValue: mockContractPairLoader,
        },
      ],
    }).compile();

    service = module.get<DataIngestionService>(DataIngestionService);

    // Clear mocks
    vi.clearAllMocks();

    // Re-apply default mock return values after clearAllMocks
    mockDegradationService.isDegraded.mockReturnValue(false);
    mockContractPairLoader.getActivePairs.mockReturnValue(TEST_PAIRS);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should inject both KalshiConnector and PolymarketConnector', () => {
    expect(service['kalshiConnector']).toBeDefined();
    expect(service['polymarketConnector']).toBeDefined();
  });

  describe('onModuleInit()', () => {
    it('should register WebSocket callback for Kalshi', async () => {
      await service.onModuleInit();

      expect(mockKalshiConnector.onOrderBookUpdate).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it('should register WebSocket callback for Polymarket', async () => {
      await service.onModuleInit();

      expect(mockPolymarketConnector.onOrderBookUpdate).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it('should register both platform WebSocket callbacks', async () => {
      await service.onModuleInit();

      expect(mockKalshiConnector.onOrderBookUpdate).toHaveBeenCalled();
      expect(mockPolymarketConnector.onOrderBookUpdate).toHaveBeenCalled();
    });
  });

  describe('ingestCurrentOrderBooks()', () => {
    it('should call getActivePairs to determine tickers', async () => {
      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      expect(mockContractPairLoader.getActivePairs).toHaveBeenCalled();
    });

    it('should fetch, persist and emit event for configured pairs', async () => {
      const normalizedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockResolvedValue(normalizedBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // Verify connector called with configured ticker
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledWith(
        'KALSHI-TICKER-1',
      );

      // Verify persistence
      expect(mockPrismaService.orderBookSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: 'KALSHI',
          contract_id: 'KALSHI-TICKER-1',
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

    it('should ingest from both Kalshi and Polymarket platforms', async () => {
      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [{ price: 0.55, quantity: 1500 }],
        asks: [{ price: 0.58, quantity: 1200 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue(polymarketBook);
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // Both connectors should be called
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalled();
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalled();

      // Health tracking for both platforms
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.KALSHI,
        expect.any(Number),
      );
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.POLYMARKET,
        expect.any(Number),
      );
    });

    it('should ingest order books for ALL configured pairs', async () => {
      mockKalshiConnector.getOrderBook.mockImplementation((ticker: string) =>
        Promise.resolve({
          platformId: PlatformId.KALSHI,
          contractId: ticker,
          bids: [{ price: 0.6, quantity: 1000 }],
          asks: [{ price: 0.65, quantity: 800 }],
          timestamp: new Date(),
        }),
      );

      mockPolymarketConnector.getOrderBook.mockImplementation(
        (tokenId: string) =>
          Promise.resolve({
            platformId: PlatformId.POLYMARKET,
            contractId: tokenId,
            bids: [{ price: 0.55, quantity: 1500 }],
            asks: [{ price: 0.58, quantity: 1200 }],
            timestamp: new Date(),
          }),
      );

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // Kalshi should be called with each ticker from TEST_PAIRS
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledWith(
        'KALSHI-TICKER-1',
      );
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledWith(
        'KALSHI-TICKER-2',
      );
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledTimes(2);

      // Polymarket should be called with each token from TEST_PAIRS
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalledWith(
        'pm-token-1',
      );
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalledWith(
        'pm-token-2',
      );
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalledTimes(2);

      // OrderBookUpdatedEvent emitted for each successful ingestion (2 Kalshi + 2 Polymarket)
      const orderbookEmits = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'orderbook.updated',
      );
      expect(orderbookEmits).toHaveLength(4);
    });

    it('should skip ingestion and log warning when no active pairs configured', async () => {
      mockContractPairLoader.getActivePairs.mockReturnValue([]);

      await service.ingestCurrentOrderBooks();

      // Neither connector should be called
      expect(mockKalshiConnector.getOrderBook).not.toHaveBeenCalled();
      expect(mockPolymarketConnector.getOrderBook).not.toHaveBeenCalled();

      // No events emitted
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should handle Kalshi failure without affecting Polymarket ingestion', async () => {
      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [{ price: 0.55, quantity: 1500 }],
        asks: [{ price: 0.58, quantity: 1200 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockRejectedValue(
        new Error('Kalshi API error'),
      );
      mockPolymarketConnector.getOrderBook.mockResolvedValue(polymarketBook);
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await expect(service.ingestCurrentOrderBooks()).resolves.not.toThrow();

      // Polymarket should still be ingested
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalled();
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.POLYMARKET,
        expect.any(Number),
      );
    });

    it('should handle Polymarket failure without affecting Kalshi ingestion', async () => {
      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);
      mockPolymarketConnector.getOrderBook.mockRejectedValue(
        new Error('Polymarket API error'),
      );
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await expect(service.ingestCurrentOrderBooks()).resolves.not.toThrow();

      // Kalshi should still be ingested
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalled();
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.KALSHI,
        expect.any(Number),
      );
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

    it('should process Polymarket WebSocket updates', async () => {
      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'POLYMARKET-TOKEN',
        bids: [{ price: 0.55, quantity: 1500 }],
        asks: [{ price: 0.58, quantity: 1200 }],
        timestamp: new Date(),
        sequenceNumber: 67890,
      };

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service['processWebSocketUpdate'](polymarketBook);

      expect(mockPrismaService.orderBookSnapshot.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'orderbook.updated',
        expect.any(OrderBookUpdatedEvent),
      );
      expect(mockHealthService.recordUpdate).toHaveBeenCalledWith(
        PlatformId.POLYMARKET,
        expect.any(Number),
      );
    });

    it('should emit orderbook.updated events with distinct platformId values', async () => {
      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-MARKET',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };

      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'POLYMARKET-TOKEN',
        bids: [{ price: 0.55, quantity: 1500 }],
        asks: [{ price: 0.58, quantity: 1200 }],
        timestamp: new Date(),
      };

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service['processWebSocketUpdate'](kalshiBook);
      await service['processWebSocketUpdate'](polymarketBook);

      // Extract all orderbook.updated events
      /* eslint-disable @typescript-eslint/no-unsafe-member-access */
      const orderbookEvents = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'orderbook.updated',
      );

      expect(orderbookEvents).toHaveLength(2);

      const kalshiEvent = orderbookEvents.find(
        (call) => call[1].orderBook.platformId === PlatformId.KALSHI,
      );

      const polymarketEvent = orderbookEvents.find(
        (call) => call[1].orderBook.platformId === PlatformId.POLYMARKET,
      );

      expect(kalshiEvent).toBeDefined();
      expect(polymarketEvent).toBeDefined();
      expect(kalshiEvent![1].orderBook.platformId).not.toBe(
        polymarketEvent![1].orderBook.platformId,
      );
      /* eslint-enable @typescript-eslint/no-unsafe-member-access */
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

    it('should throw SystemHealthError after 10 consecutive failures', async () => {
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

      const promise = service['persistSnapshot'](book);
      await expect(promise).rejects.toThrow(SystemHealthError);
      const err = await promise.catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 4005,
        message: 'Persistent snapshot write failure',
        severity: 'critical',
        component: 'data-ingestion',
      });
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

  describe('degradation polling fallback', () => {
    it('should skip degraded platforms in normal ingestion loop', async () => {
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [{ price: 0.55, quantity: 1500 }],
        asks: [{ price: 0.58, quantity: 1200 }],
        timestamp: new Date(),
      };
      mockPolymarketConnector.getOrderBook.mockResolvedValue(polymarketBook);

      // Kalshi connector should return a book for degraded polling
      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };
      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);

      await service.ingestCurrentOrderBooks();

      // Kalshi normal polling should be skipped (degraded)
      // But Kalshi degraded polling should still call getOrderBook
      // Polymarket normal polling should proceed
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalled();
    });

    it('should call pollDegradedPlatforms for degraded platforms', async () => {
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      const degradedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-DEGRADED',
        bids: [{ price: 0.5, quantity: 500 }],
        asks: [{ price: 0.55, quantity: 400 }],
        timestamp: new Date(),
      };
      mockKalshiConnector.getOrderBook.mockResolvedValue(degradedBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // Should call incrementPollingCycle for degraded Kalshi
      expect(mockDegradationService.incrementPollingCycle).toHaveBeenCalledWith(
        PlatformId.KALSHI,
      );
    });

    it('should set platformHealth to degraded on polled order books', async () => {
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      const degradedBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-DEGRADED',
        bids: [{ price: 0.5, quantity: 500 }],
        asks: [{ price: 0.55, quantity: 400 }],
        timestamp: new Date(),
      };
      mockKalshiConnector.getOrderBook.mockResolvedValue(degradedBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // The book passed to persistSnapshot should have platformHealth: 'degraded'
      expect(degradedBook).toHaveProperty('platformHealth', 'degraded');
    });

    it('should not poll when platform recovers (isDegraded returns false)', async () => {
      mockDegradationService.isDegraded.mockReturnValue(false);
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };
      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };
      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue(polymarketBook);

      await service.ingestCurrentOrderBooks();

      // incrementPollingCycle should NOT be called (no degraded platforms)
      expect(
        mockDegradationService.incrementPollingCycle,
      ).not.toHaveBeenCalled();
    });

    it('should use contract-pair-derived tickers in degraded polling', async () => {
      mockDegradationService.isDegraded.mockReturnValue(true);
      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      const kalshiBook = {
        platformId: PlatformId.KALSHI,
        contractId: 'KALSHI-TICKER-1',
        bids: [{ price: 0.6, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };
      const polymarketBook = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'pm-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      };
      mockKalshiConnector.getOrderBook.mockResolvedValue(kalshiBook);
      mockPolymarketConnector.getOrderBook.mockResolvedValue(polymarketBook);

      await service.ingestCurrentOrderBooks();

      // Degraded polling should use configured tickers, not hardcoded placeholders
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledWith(
        'KALSHI-TICKER-1',
      );
      expect(mockKalshiConnector.getOrderBook).toHaveBeenCalledWith(
        'KALSHI-TICKER-2',
      );
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalledWith(
        'pm-token-1',
      );
      expect(mockPolymarketConnector.getOrderBook).toHaveBeenCalledWith(
        'pm-token-2',
      );
    });
  });

  describe('ingestion → detection data flow (integration)', () => {
    it('should emit OrderBookUpdatedEvent with correct contractId for each of 3 mock pairs', async () => {
      const threePairs: ContractPairConfig[] = [
        {
          kalshiContractId: 'KALSHI-A',
          polymarketContractId: 'pm-a',
          eventDescription: 'Event A',
          operatorVerificationTimestamp: new Date('2026-02-27T00:00:00Z'),
          primaryLeg: 'kalshi',
        },
        {
          kalshiContractId: 'KALSHI-B',
          polymarketContractId: 'pm-b',
          eventDescription: 'Event B',
          operatorVerificationTimestamp: new Date('2026-02-27T00:00:00Z'),
          primaryLeg: 'polymarket',
        },
        {
          kalshiContractId: 'KALSHI-C',
          polymarketContractId: 'pm-c',
          eventDescription: 'Event C',
          operatorVerificationTimestamp: new Date('2026-02-27T00:00:00Z'),
          primaryLeg: 'kalshi',
        },
      ];

      mockContractPairLoader.getActivePairs.mockReturnValue(threePairs);

      mockKalshiConnector.getOrderBook.mockImplementation((ticker: string) =>
        Promise.resolve({
          platformId: PlatformId.KALSHI,
          contractId: ticker,
          bids: [{ price: 0.6, quantity: 1000 }],
          asks: [{ price: 0.65, quantity: 800 }],
          timestamp: new Date(),
        }),
      );

      mockPolymarketConnector.getOrderBook.mockImplementation(
        (tokenId: string) =>
          Promise.resolve({
            platformId: PlatformId.POLYMARKET,
            contractId: tokenId,
            bids: [{ price: 0.55, quantity: 1500 }],
            asks: [{ price: 0.58, quantity: 1200 }],
            timestamp: new Date(),
          }),
      );

      mockPrismaService.orderBookSnapshot.create.mockResolvedValue({});

      await service.ingestCurrentOrderBooks();

      // 3 Kalshi + 3 Polymarket = 6 OrderBookUpdatedEvent emissions
      /* eslint-disable @typescript-eslint/no-unsafe-member-access */
      const orderbookEmits = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'orderbook.updated',
      );
      expect(orderbookEmits).toHaveLength(6);

      // Verify each pair's contractIds appear in the emitted events
      const emittedContractIds = orderbookEmits.map(
        (call) => call[1].orderBook.contractId as string,
      );
      /* eslint-enable @typescript-eslint/no-unsafe-member-access */

      expect(emittedContractIds).toContain('KALSHI-A');
      expect(emittedContractIds).toContain('KALSHI-B');
      expect(emittedContractIds).toContain('KALSHI-C');
      expect(emittedContractIds).toContain('pm-a');
      expect(emittedContractIds).toContain('pm-b');
      expect(emittedContractIds).toContain('pm-c');
    });
  });
});
