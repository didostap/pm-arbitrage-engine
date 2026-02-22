import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ConnectorModule } from './connector.module';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from './connector.constants';
import { KalshiConnector } from './kalshi/kalshi.connector';
import { PolymarketConnector } from './polymarket/polymarket.connector';
import { PaperTradingConnector } from './paper/paper-trading.connector';
import { PlatformId } from '../common/types/platform.type';

// Mock heavy modules to avoid pulling the full app
vi.mock('./kalshi/kalshi.connector', () => ({
  KalshiConnector: class MockKalshiConnector {
    getPlatformId() {
      return PlatformId.KALSHI;
    }
    getHealth() {
      return {
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
      };
    }
  },
}));

vi.mock('./polymarket/polymarket.connector', () => ({
  PolymarketConnector: class MockPolymarketConnector {
    getPlatformId() {
      return PlatformId.POLYMARKET;
    }
    getHealth() {
      return {
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 100,
      };
    }
  },
}));

vi.mock('../modules/data-ingestion/data-ingestion.module', () => ({
  DataIngestionModule: class MockDataIngestionModule {},
}));

describe('ConnectorModule', () => {
  async function createModule(envOverrides: Record<string, string> = {}) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => envOverrides],
        }),
        ConnectorModule,
      ],
    }).compile();
    return moduleRef;
  }

  describe('Kalshi connector token', () => {
    it('should resolve to PaperTradingConnector when PLATFORM_MODE_KALSHI=paper', async () => {
      const mod = await createModule({ PLATFORM_MODE_KALSHI: 'paper' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(KALSHI_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(PaperTradingConnector);
    });

    it('should resolve to KalshiConnector when PLATFORM_MODE_KALSHI=live', async () => {
      const mod = await createModule({ PLATFORM_MODE_KALSHI: 'live' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(KALSHI_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(KalshiConnector);
    });

    it('should default to KalshiConnector when PLATFORM_MODE_KALSHI is unset', async () => {
      const mod = await createModule({});
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(KALSHI_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(KalshiConnector);
    });
  });

  describe('Polymarket connector token', () => {
    it('should resolve to PaperTradingConnector when PLATFORM_MODE_POLYMARKET=paper', async () => {
      const mod = await createModule({ PLATFORM_MODE_POLYMARKET: 'paper' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(POLYMARKET_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(PaperTradingConnector);
    });

    it('should resolve to PolymarketConnector when PLATFORM_MODE_POLYMARKET=live', async () => {
      const mod = await createModule({ PLATFORM_MODE_POLYMARKET: 'live' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(POLYMARKET_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(PolymarketConnector);
    });

    it('should default to PolymarketConnector when PLATFORM_MODE_POLYMARKET is unset', async () => {
      const mod = await createModule({});
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const connector = mod.get(POLYMARKET_CONNECTOR_TOKEN);

      expect(connector).toBeInstanceOf(PolymarketConnector);
    });
  });

  describe('config validation', () => {
    it('should throw ConfigValidationError for invalid latency value', async () => {
      await expect(
        createModule({
          PLATFORM_MODE_KALSHI: 'paper',
          PAPER_FILL_LATENCY_MS_KALSHI: 'not-a-number',
        }),
      ).rejects.toThrow('Invalid paper trading config for KALSHI');
    });

    it('should throw ConfigValidationError for invalid slippage value', async () => {
      await expect(
        createModule({
          PLATFORM_MODE_POLYMARKET: 'paper',
          PAPER_SLIPPAGE_BPS_POLYMARKET: 'abc',
        }),
      ).rejects.toThrow('Invalid paper trading config for POLYMARKET');
    });

    it('should throw ConfigValidationError for invalid mode value', async () => {
      await expect(
        createModule({ PLATFORM_MODE_KALSHI: 'typo' }),
      ).rejects.toThrow('Invalid platform mode for KALSHI');
    });
  });
});
