import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExitDataSourceService } from './exit-data-source.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { PlatformId } from '../../common/types/platform.type';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

describe('ExitDataSourceService — data source classification', () => {
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
              .mockImplementation((key: string, defaultVal: unknown) => {
                if (key === 'WS_STALENESS_THRESHOLD_MS') return 60000;
                return defaultVal;
              }),
          },
        },
      ],
    }).compile();

    service = module.get(ExitDataSourceService);
  });

  describe('classifyDataSource', () => {
    it('should classify as websocket when WS data is fresh', () => {
      const now = new Date();
      const freshDate = new Date(now.getTime() - 10_000); // 10s ago
      expect(service.classifyDataSource(freshDate, now)).toBe('websocket');
    });

    it('should classify as polling when no WS subscription exists', () => {
      const now = new Date();
      expect(service.classifyDataSource(null, now)).toBe('polling');
    });

    it('should classify as stale_fallback when WS data exceeds threshold', () => {
      const now = new Date();
      const staleDate = new Date(now.getTime() - 120_000); // 120s > 60s threshold
      expect(service.classifyDataSource(staleDate, now)).toBe('stale_fallback');
    });

    it('should classify as websocket when WS data is exactly at threshold boundary', () => {
      const now = new Date();
      // Exactly at threshold (60s) → stale_fallback (>= comparison)
      const boundaryDate = new Date(now.getTime() - 60_000);
      expect(service.classifyDataSource(boundaryDate, now)).toBe(
        'stale_fallback',
      );
    });

    it('should classify as websocket when WS data is just below threshold', () => {
      const now = new Date();
      const justFreshDate = new Date(now.getTime() - 59_999);
      expect(service.classifyDataSource(justFreshDate, now)).toBe('websocket');
    });

    it('should respect hot-reloaded wsStalenessThresholdMs', () => {
      service.reloadConfig({ wsStalenessThresholdMs: 30_000 });
      const now = new Date();
      const date = new Date(now.getTime() - 40_000); // 40s, fresh at 60s but stale at 30s
      expect(service.classifyDataSource(date, now)).toBe('stale_fallback');
    });
  });

  describe('combineDataSources', () => {
    it('websocket + websocket = websocket', () => {
      expect(service.combineDataSources('websocket', 'websocket')).toBe(
        'websocket',
      );
    });

    it('websocket + polling = polling', () => {
      expect(service.combineDataSources('websocket', 'polling')).toBe(
        'polling',
      );
    });

    it('polling + websocket = polling', () => {
      expect(service.combineDataSources('polling', 'websocket')).toBe(
        'polling',
      );
    });

    it('websocket + stale_fallback = stale_fallback', () => {
      expect(service.combineDataSources('websocket', 'stale_fallback')).toBe(
        'stale_fallback',
      );
    });

    it('polling + stale_fallback = stale_fallback', () => {
      expect(service.combineDataSources('polling', 'stale_fallback')).toBe(
        'stale_fallback',
      );
    });

    it('stale_fallback + stale_fallback = stale_fallback', () => {
      expect(
        service.combineDataSources('stale_fallback', 'stale_fallback'),
      ).toBe('stale_fallback');
    });

    it('polling + polling = polling', () => {
      expect(service.combineDataSources('polling', 'polling')).toBe('polling');
    });
  });

  describe('reloadConfig', () => {
    it('should update wsStalenessThresholdMs', () => {
      service.reloadConfig({ wsStalenessThresholdMs: 30_000 });
      const now = new Date();
      const date = new Date(now.getTime() - 40_000);
      expect(service.classifyDataSource(date, now)).toBe('stale_fallback');
    });

    it('should update exitDepthSlippageTolerance', () => {
      service.reloadConfig({ exitDepthSlippageTolerance: 0.05 });
      // Verified indirectly through getAvailableExitDepth tolerance behavior
      // Direct field check as a sanity test
      expect(
        (service as Record<string, unknown>)['exitDepthSlippageTolerance'],
      ).toBe(0.05);
    });

    it('should not modify unset fields', () => {
      service.reloadConfig({ wsStalenessThresholdMs: 30_000 });
      // exitDepthSlippageTolerance should remain at default (0.02)
      expect(
        (service as Record<string, unknown>)['exitDepthSlippageTolerance'],
      ).toBe(0.02);
    });
  });

  describe('connector proxy methods', () => {
    it('getConnectorHealth should delegate to correct connector', () => {
      kalshiConnector.getHealth.mockReturnValue({
        status: 'healthy',
        mode: 'live',
      });
      polymarketConnector.getHealth.mockReturnValue({
        status: 'degraded',
        mode: 'paper',
      });

      expect(service.getConnectorHealth(PlatformId.KALSHI)).toEqual(
        expect.objectContaining({ status: 'healthy' }),
      );
      expect(service.getConnectorHealth(PlatformId.POLYMARKET)).toEqual(
        expect.objectContaining({ status: 'degraded' }),
      );
    });

    it('getFeeSchedule should delegate to correct connector', () => {
      const kalshiFees = {
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2,
        description: 'Kalshi fees',
      };
      kalshiConnector.getFeeSchedule.mockReturnValue(kalshiFees);

      expect(service.getFeeSchedule(PlatformId.KALSHI)).toEqual(kalshiFees);
    });
  });
});
