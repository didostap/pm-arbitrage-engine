/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformHealthService } from './platform-health.service';
import { PrismaService } from '../../common/prisma.service';
import { PlatformId, PlatformHealth } from '../../common/types/platform.type';
import {
  PlatformDegradedEvent,
  PlatformRecoveredEvent,
} from '../../common/events/platform.events';
import { vi } from 'vitest';

describe('PlatformHealthService', () => {
  let service: PlatformHealthService;

  const mockPrismaService = {
    platformHealthLog: {
      create: vi.fn(),
    },
  };

  const mockEventEmitter = {
    emit: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformHealthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<PlatformHealthService>(PlatformHealthService);

    // Clear mocks
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recordUpdate()', () => {
    it('should track update time and latency', () => {
      const platform = PlatformId.KALSHI;
      const latency = 150;

      service.recordUpdate(platform, latency);

      // Verify internal state (accessing private fields for testing)
      const lastUpdate = service['lastUpdateTime'].get(platform);
      expect(lastUpdate).toBeGreaterThan(0);

      const samples = service['latencySamples'].get(platform);
      expect(samples).toContain(latency);
    });

    it('should maintain rolling window of 100 samples', () => {
      const platform = PlatformId.KALSHI;

      // Add 150 samples
      for (let i = 0; i < 150; i++) {
        service.recordUpdate(platform, i);
      }

      const samples = service['latencySamples'].get(platform);
      expect(samples).toHaveLength(100); // Should keep only last 100
    });
  });

  describe('publishHealth()', () => {
    it('should persist health log to database', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Record an update to make platform healthy
      service.recordUpdate(PlatformId.KALSHI, 100);

      await service.publishHealth();

      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: 'KALSHI', // Uppercase to match DB enum
          status: 'healthy',
        }),
      });
    });

    it('should emit platform.health.updated event', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});
      service.recordUpdate(PlatformId.KALSHI, 100);

      await service.publishHealth();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.updated',
        expect.objectContaining({
          platformId: PlatformId.KALSHI,
          status: 'healthy',
        }),
      );
    });

    it('should emit degraded event on healthy → degraded transition', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Start healthy
      service.recordUpdate(PlatformId.KALSHI, 100);
      await service.publishHealth();

      // Clear previous calls
      vi.clearAllMocks();

      // Simulate staleness by setting lastUpdateTime to 61 seconds ago
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.KALSHI, sixtyOneSecondsAgo);

      await service.publishHealth();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.degraded',
        expect.any(PlatformDegradedEvent),
      );
    });

    it('should emit recovered event on degraded → healthy transition', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Start degraded (no updates)
      await service.publishHealth();

      // Clear previous calls
      vi.clearAllMocks();

      // Now record fresh update (make healthy)
      service.recordUpdate(PlatformId.KALSHI, 100);
      await service.publishHealth();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.recovered',
        expect.any(PlatformRecoveredEvent),
      );
    });

    it('should continue on persistence error', async () => {
      mockPrismaService.platformHealthLog.create.mockRejectedValue(
        new Error('Database error'),
      );

      service.recordUpdate(PlatformId.KALSHI, 100);

      // Should not throw
      await expect(service.publishHealth()).resolves.not.toThrow();

      // Should still emit event
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.updated',
        expect.any(Object),
      );
    });

    it('should publish health for both KALSHI and POLYMARKET platforms', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Record updates for both platforms
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 120);

      await service.publishHealth();

      // Should persist health logs for both platforms
      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platform: 'KALSHI',
          }),
        }),
      );
      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platform: 'POLYMARKET',
          }),
        }),
      );
    });

    it('should emit degraded event for Polymarket when stale', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Kalshi healthy, Polymarket stale
      service.recordUpdate(PlatformId.KALSHI, 100);
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.POLYMARKET, sixtyOneSecondsAgo);

      await service.publishHealth();

      // Should emit degraded event for Polymarket
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.degraded',
        expect.objectContaining({
          platformId: PlatformId.POLYMARKET,
        }),
      );
    });

    it('should emit recovered event for Polymarket when recovered', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Start Polymarket degraded (no updates)
      await service.publishHealth();

      // Clear previous calls
      vi.clearAllMocks();

      // Now record fresh update for Polymarket (make healthy)
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Should emit recovered event for Polymarket
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'platform.health.recovered',
        expect.objectContaining({
          platformId: PlatformId.POLYMARKET,
        }),
      );
    });

    it('should handle mixed health states (one healthy, one degraded)', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Kalshi healthy
      service.recordUpdate(PlatformId.KALSHI, 100);

      // Polymarket degraded (stale)
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.POLYMARKET, sixtyOneSecondsAgo);

      await service.publishHealth();

      // Should emit health.updated for both platforms
      const healthUpdatedCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'platform.health.updated',
      );
      expect(healthUpdatedCalls).toHaveLength(2);

      // Should have one healthy and one degraded status
      const statuses = healthUpdatedCalls.map(
        (call) => (call[1] as PlatformHealth).status,
      );
      expect(statuses).toContain('healthy');
      expect(statuses).toContain('degraded');
    });
  });

  describe('calculateHealth()', () => {
    it('should return healthy status with recent updates', () => {
      service.recordUpdate(PlatformId.KALSHI, 100);

      const health = service['calculateHealth'](PlatformId.KALSHI);

      expect(health.status).toBe('healthy');
      expect(health.platformId).toBe(PlatformId.KALSHI);
      expect(health.lastHeartbeat).toBeInstanceOf(Date);
    });

    it('should return degraded status for stale data (>60s)', () => {
      // Record update with old timestamp
      const platform = PlatformId.KALSHI;
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(platform, sixtyOneSecondsAgo);

      const health = service['calculateHealth'](platform);

      expect(health.status).toBe('degraded');
      expect(health.metadata?.degradationReason).toBe('stale_data');
    });

    it('should return degraded status for high latency (>2s)', () => {
      const platform = PlatformId.KALSHI;

      // Record updates with high latency
      for (let i = 0; i < 100; i++) {
        service.recordUpdate(platform, 2500); // 2.5s latency
      }

      const health = service['calculateHealth'](platform);

      expect(health.status).toBe('degraded');
      expect(health.metadata?.degradationReason).toBe('high_latency');
    });

    it('should return healthy with acceptable latency (<2s)', () => {
      const platform = PlatformId.KALSHI;

      // Record updates with low latency
      for (let i = 0; i < 100; i++) {
        service.recordUpdate(platform, 500); // 500ms latency
      }

      const health = service['calculateHealth'](platform);

      expect(health.status).toBe('healthy');
      expect(health.latencyMs).toBeLessThan(2000);
    });

    it('should return degraded status when no updates recorded', () => {
      const platform = PlatformId.KALSHI;

      const health = service['calculateHealth'](platform);

      // No updates = age > threshold = degraded
      expect(health.status).toBe('degraded');
    });

    it('should include p95 latency in health response', () => {
      const platform = PlatformId.KALSHI;

      for (let i = 0; i < 100; i++) {
        service.recordUpdate(platform, 100 + i);
      }

      const health = service['calculateHealth'](platform);

      expect(health.latencyMs).toBeGreaterThan(0);
      expect(typeof health.latencyMs).toBe('number');
    });
  });

  describe('getAggregatedHealth()', () => {
    it('should return health for all platforms', () => {
      // Record updates for both platforms
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 120);

      const aggregatedHealth = service.getAggregatedHealth();

      expect(aggregatedHealth).toBeInstanceOf(Map);
      expect(aggregatedHealth.size).toBe(2);
      expect(aggregatedHealth.has(PlatformId.KALSHI)).toBe(true);
      expect(aggregatedHealth.has(PlatformId.POLYMARKET)).toBe(true);
    });

    it('should return current health status for each platform', () => {
      // Kalshi healthy
      service.recordUpdate(PlatformId.KALSHI, 100);

      // Polymarket degraded (stale)
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.POLYMARKET, sixtyOneSecondsAgo);

      const aggregatedHealth = service.getAggregatedHealth();

      const kalshiHealth = aggregatedHealth.get(PlatformId.KALSHI);
      const polymarketHealth = aggregatedHealth.get(PlatformId.POLYMARKET);

      expect(kalshiHealth?.status).toBe('healthy');
      expect(polymarketHealth?.status).toBe('degraded');
    });
  });

  describe('getPlatformHealth()', () => {
    it('should return health for specific platform', () => {
      service.recordUpdate(PlatformId.KALSHI, 100);

      const health = service.getPlatformHealth(PlatformId.KALSHI);

      expect(health.platformId).toBe(PlatformId.KALSHI);
      expect(health.status).toBe('healthy');
    });

    it('should return independent health for each platform', () => {
      // Kalshi healthy
      service.recordUpdate(PlatformId.KALSHI, 100);

      // Polymarket degraded (stale)
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.POLYMARKET, sixtyOneSecondsAgo);

      const kalshiHealth = service.getPlatformHealth(PlatformId.KALSHI);
      const polymarketHealth = service.getPlatformHealth(PlatformId.POLYMARKET);

      expect(kalshiHealth.status).toBe('healthy');
      expect(polymarketHealth.status).toBe('degraded');
    });
  });

  describe('calculateP95Latency()', () => {
    it('should return null for no samples', () => {
      const p95 = service['calculateP95Latency'](PlatformId.KALSHI);
      expect(p95).toBeNull();
    });

    it('should calculate p95 correctly', () => {
      const platform = PlatformId.KALSHI;

      // Add 100 samples: 0, 1, 2, ..., 99
      for (let i = 0; i < 100; i++) {
        service.recordUpdate(platform, i);
      }

      const p95 = service['calculateP95Latency'](platform);

      // p95 of [0..99] should be 95
      expect(p95).toBe(95);
    });

    it('should handle small sample sizes', () => {
      const platform = PlatformId.KALSHI;

      service.recordUpdate(platform, 100);
      service.recordUpdate(platform, 200);

      const p95 = service['calculateP95Latency'](platform);

      // p95 of 2 samples at index floor(2 * 0.95) = 1
      expect(p95).toBeGreaterThan(0);
    });
  });
});
