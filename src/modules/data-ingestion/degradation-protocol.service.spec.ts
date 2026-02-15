/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { DegradationProtocolService } from './degradation-protocol.service.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import {
  DegradationProtocolActivatedEvent,
  DegradationProtocolDeactivatedEvent,
} from '../../common/events/platform.events.js';

describe('DegradationProtocolService', () => {
  let service: DegradationProtocolService;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DegradationProtocolService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: vi.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, defaultValue?: number) => {
              if (key === 'DEGRADATION_THRESHOLD_MULTIPLIER') return 1.5;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DegradationProtocolService>(
      DegradationProtocolService,
    );
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  describe('activateProtocol', () => {
    it('should emit degradation.protocol.activated event with correct payload', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED,
        expect.any(DegradationProtocolActivatedEvent),
      );

      const emittedEvent = vi.mocked(eventEmitter.emit).mock.calls[0]?.[1] as
        | DegradationProtocolActivatedEvent
        | undefined;
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent!.platformId).toBe(PlatformId.KALSHI);
      expect(emittedEvent!.reason).toBe('websocket_timeout');
      expect(emittedEvent!.healthyPlatforms).toEqual([PlatformId.POLYMARKET]);
    });

    it('should be idempotent — double-activate same platform is a no-op', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('deactivateProtocol', () => {
    it('should emit degradation.protocol.deactivated event with outage duration', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');
      vi.mocked(eventEmitter.emit).mockClear();

      service.deactivateProtocol(PlatformId.KALSHI);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DEGRADATION_PROTOCOL_DEACTIVATED,
        expect.any(DegradationProtocolDeactivatedEvent),
      );

      const emittedEvent = vi.mocked(eventEmitter.emit).mock.calls[0]?.[1] as
        | DegradationProtocolDeactivatedEvent
        | undefined;
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent!.platformId).toBe(PlatformId.KALSHI);
      expect(emittedEvent!.outageDurationMs).toBeGreaterThanOrEqual(0);
      expect(emittedEvent!.impactSummary.reason).toBe('websocket_timeout');
      expect(emittedEvent!.impactSummary.pollingCycleCount).toBe(0);
    });

    it('should not emit when deactivating non-degraded platform', () => {
      service.deactivateProtocol(PlatformId.KALSHI);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getEdgeThresholdMultiplier', () => {
    it('should return 1.0 when no platforms are degraded', () => {
      expect(service.getEdgeThresholdMultiplier(PlatformId.KALSHI)).toBe(1.0);
      expect(service.getEdgeThresholdMultiplier(PlatformId.POLYMARKET)).toBe(
        1.0,
      );
    });

    it('should return 1.5 for healthy platform when another platform is degraded', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      expect(service.getEdgeThresholdMultiplier(PlatformId.POLYMARKET)).toBe(
        1.5,
      );
    });

    it('should return 1.0 for the degraded platform itself', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      expect(service.getEdgeThresholdMultiplier(PlatformId.KALSHI)).toBe(1.0);
    });
  });

  describe('isDegraded', () => {
    it('should correctly track degraded state', () => {
      expect(service.isDegraded(PlatformId.KALSHI)).toBe(false);

      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');
      expect(service.isDegraded(PlatformId.KALSHI)).toBe(true);

      service.deactivateProtocol(PlatformId.KALSHI);
      expect(service.isDegraded(PlatformId.KALSHI)).toBe(false);
    });
  });

  describe('multiple platforms', () => {
    it('should degrade platforms independently', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');
      service.activateProtocol(PlatformId.POLYMARKET, 'api_error');

      expect(service.isDegraded(PlatformId.KALSHI)).toBe(true);
      expect(service.isDegraded(PlatformId.POLYMARKET)).toBe(true);

      service.deactivateProtocol(PlatformId.KALSHI);
      expect(service.isDegraded(PlatformId.KALSHI)).toBe(false);
      expect(service.isDegraded(PlatformId.POLYMARKET)).toBe(true);
    });
  });

  describe('incrementPollingCycle', () => {
    it('should increment polling cycle count for degraded platform', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      service.incrementPollingCycle(PlatformId.KALSHI);
      service.incrementPollingCycle(PlatformId.KALSHI);

      const state = service.getDegradationState(PlatformId.KALSHI);
      expect(state).toBeDefined();
      expect(state!.pollingCycleCount).toBe(2);
    });

    it('should be a no-op for non-degraded platform', () => {
      service.incrementPollingCycle(PlatformId.KALSHI);
      expect(service.getDegradationState(PlatformId.KALSHI)).toBeNull();
    });
  });

  describe('getDegradationState', () => {
    it('should return null for non-degraded platform', () => {
      expect(service.getDegradationState(PlatformId.KALSHI)).toBeNull();
    });

    it('should return state for degraded platform', () => {
      service.activateProtocol(PlatformId.KALSHI, 'websocket_timeout');

      const state = service.getDegradationState(PlatformId.KALSHI);
      expect(state).toBeDefined();
      expect(state!.reason).toBe('websocket_timeout');
      expect(state!.pollingCycleCount).toBe(0);
      expect(state!.degradedAt).toBeInstanceOf(Date);
    });
  });
});
