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
import { DegradationProtocolService } from './degradation-protocol.service';

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

  const mockDegradationService = {
    isDegraded: vi.fn().mockReturnValue(false),
    activateProtocol: vi.fn(),
    deactivateProtocol: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformHealthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        {
          provide: DegradationProtocolService,
          useValue: mockDegradationService,
        },
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
    it('should NOT persist health log when status is unchanged (healthy → healthy)', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Record an update to make platform healthy
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      // First tick: both default to 'healthy', calculated as 'healthy' → no transition
      await service.publishHealth();

      expect(mockPrismaService.platformHealthLog.create).not.toHaveBeenCalled();
    });

    it('should persist health log when status transitions (healthy → degraded)', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Kalshi stale → degraded (transitions from default 'healthy')
      const sixtyOneSecondsAgo = Date.now() - 61_000;
      service['lastUpdateTime'].set(PlatformId.KALSHI, sixtyOneSecondsAgo);

      // Polymarket fresh → healthy (no transition from default 'healthy')
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      await service.publishHealth();

      // Only Kalshi should get a DB write (status changed)
      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledTimes(
        1,
      );
      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: 'KALSHI',
          status: 'degraded',
        }),
      });
    });

    it('should persist on first-tick-degraded (differs from default healthy)', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Don't record any updates — both platforms will calculate as degraded
      // previousStatus defaults to 'healthy', so degraded != 'healthy' → DB write
      await service.publishHealth();

      // Both platforms should get a DB write
      expect(mockPrismaService.platformHealthLog.create).toHaveBeenCalledTimes(
        2,
      );
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

    it('should emit health events for both platforms even without DB write', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Record updates for both platforms (both healthy, no transition from default)
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 120);

      await service.publishHealth();

      // No DB writes (no status transitions)
      expect(mockPrismaService.platformHealthLog.create).not.toHaveBeenCalled();

      // But events should still fire for both platforms
      const healthUpdatedCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'platform.health.updated',
      );
      expect(healthUpdatedCalls).toHaveLength(2);
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

  describe('Consecutive-check hysteresis', () => {
    it('should NOT degrade on single unhealthy tick', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Keep Polymarket healthy
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      // Make Kalshi stale (>60s)
      const sixtyFiveSecondsAgo = Date.now() - 65_000;
      service['lastUpdateTime'].set(PlatformId.KALSHI, sixtyFiveSecondsAgo);

      await service.publishHealth();

      expect(mockDegradationService.activateProtocol).not.toHaveBeenCalled();
    });

    it('should degrade after 2 consecutive unhealthy ticks', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Keep Polymarket healthy
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      // Tick 1: Kalshi stale
      const sixtyFiveSecondsAgo = Date.now() - 65_000;
      service['lastUpdateTime'].set(PlatformId.KALSHI, sixtyFiveSecondsAgo);
      await service.publishHealth();

      expect(mockDegradationService.activateProtocol).not.toHaveBeenCalled();

      // Tick 2: Kalshi still stale
      service.recordUpdate(PlatformId.POLYMARKET, 100); // keep polymarket fresh
      await service.publishHealth();

      expect(mockDegradationService.activateProtocol).toHaveBeenCalledWith(
        PlatformId.KALSHI,
        'websocket_timeout',
        expect.any(Date),
      );
    });

    it('should NOT recover on single healthy tick after degradation', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Simulate previously degraded state
      service['previousStatus'].set(PlatformId.KALSHI, 'degraded');
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      // Make Kalshi fresh now
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      // Tick 1: healthy — but should not deactivate yet
      await service.publishHealth();

      expect(mockDegradationService.deactivateProtocol).not.toHaveBeenCalled();
    });

    it('should recover after 2 consecutive healthy ticks', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Simulate previously degraded state
      service['previousStatus'].set(PlatformId.KALSHI, 'degraded');
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      // Tick 1: fresh
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      expect(mockDegradationService.deactivateProtocol).not.toHaveBeenCalled();

      // Tick 2: still fresh
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      expect(mockDegradationService.deactivateProtocol).toHaveBeenCalledWith(
        PlatformId.KALSHI,
      );
    });

    it('should reset unhealthy counter when healthy observation occurs', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});

      // Tick 1: Kalshi stale (unhealthy=1)
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      service['lastUpdateTime'].set(PlatformId.KALSHI, Date.now() - 65_000);
      await service.publishHealth();

      // Tick 2: Kalshi fresh (unhealthy=0, healthy=1)
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Tick 3: Kalshi stale again (unhealthy=1, NOT 2)
      service['lastUpdateTime'].set(PlatformId.KALSHI, Date.now() - 65_000);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Should NOT have activated protocol because counter was reset
      expect(mockDegradationService.activateProtocol).not.toHaveBeenCalled();
    });

    it('should initialize counters to 0 for all platforms', () => {
      expect(service['consecutiveUnhealthyTicks'].get(PlatformId.KALSHI)).toBe(
        0,
      );
      expect(
        service['consecutiveUnhealthyTicks'].get(PlatformId.POLYMARKET),
      ).toBe(0);
      expect(service['consecutiveHealthyTicks'].get(PlatformId.KALSHI)).toBe(0);
      expect(
        service['consecutiveHealthyTicks'].get(PlatformId.POLYMARKET),
      ).toBe(0);
    });

    it('should not have standalone 81s direct-activation path', () => {
      // Verify the WEBSOCKET_TIMEOUT_THRESHOLD property no longer exists
      expect(service).not.toHaveProperty('WEBSOCKET_TIMEOUT_THRESHOLD');
    });
  });

  describe('Recovery validation', () => {
    it('should deactivate protocol when data is fresh after 2 consecutive healthy ticks', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      // Make Kalshi degraded (previous status)
      service['previousStatus'].set(PlatformId.KALSHI, 'degraded');

      // Tick 1: fresh (healthyTicks=1)
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Not yet — needs 2 consecutive ticks
      expect(mockDegradationService.deactivateProtocol).not.toHaveBeenCalled();

      // Tick 2: still fresh (healthyTicks=2)
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      expect(mockDegradationService.deactivateProtocol).toHaveBeenCalledWith(
        PlatformId.KALSHI,
      );
    });

    it('should reject recovery when data is stale (>30s)', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );

      // Make previousStatus degraded
      service['previousStatus'].set(PlatformId.KALSHI, 'degraded');

      // Tick 1: data within 60s but >30s (so calculateHealth returns healthy, but freshness check fails)
      const thirtyFiveSecondsAgo = Date.now() - 35_000;
      service['lastUpdateTime'].set(PlatformId.KALSHI, thirtyFiveSecondsAgo);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Tick 2: same stale data (but still within 60s)
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Recovery validation should reject (data is >30s old)
      expect(mockDegradationService.deactivateProtocol).not.toHaveBeenCalled();
    });
  });

  describe('Degradation protocol exception safety', () => {
    it('should not crash publishHealth when activateProtocol throws', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});
      mockDegradationService.activateProtocol.mockImplementation(() => {
        throw new Error('degradation service exploded');
      });

      // Keep Polymarket healthy
      service.recordUpdate(PlatformId.POLYMARKET, 100);

      // Tick 1 + 2: Kalshi stale
      service['lastUpdateTime'].set(PlatformId.KALSHI, Date.now() - 65_000);
      await service.publishHealth();
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Should not throw — error is caught internally
      // And health events should still fire for both platforms
      const healthUpdatedCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'platform.health.updated',
      );
      expect(healthUpdatedCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should not crash publishHealth when deactivateProtocol throws', async () => {
      mockPrismaService.platformHealthLog.create.mockResolvedValue({});
      mockDegradationService.isDegraded.mockImplementation(
        (p: PlatformId) => p === PlatformId.KALSHI,
      );
      mockDegradationService.deactivateProtocol.mockImplementation(() => {
        throw new Error('deactivation service exploded');
      });

      service['previousStatus'].set(PlatformId.KALSHI, 'degraded');

      // Tick 1 + 2: fresh
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();
      service.recordUpdate(PlatformId.KALSHI, 100);
      service.recordUpdate(PlatformId.POLYMARKET, 100);
      await service.publishHealth();

      // Should not throw — error is caught internally
      const healthUpdatedCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === 'platform.health.updated',
      );
      expect(healthUpdatedCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
