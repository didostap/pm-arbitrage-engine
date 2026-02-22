import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KalshiConnector } from './kalshi/kalshi.connector.js';
import { PolymarketConnector } from './polymarket/polymarket.connector.js';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from './connector.constants.js';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module.js';
import { PaperTradingConnector } from './paper/paper-trading.connector.js';
import { PaperTradingConfig } from './paper/paper-trading.types.js';
import { PlatformId } from '../common/types/platform.type.js';
import { ConfigValidationError } from '../common/errors/config-validation-error.js';

function validatePlatformMode(
  config: ConfigService,
  platformId: PlatformId,
): 'live' | 'paper' {
  const suffix = platformId === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET';
  const mode = config.get<string>(`PLATFORM_MODE_${suffix}`, 'live');
  if (mode !== 'live' && mode !== 'paper') {
    throw new ConfigValidationError(`Invalid platform mode for ${suffix}`, [
      `PLATFORM_MODE_${suffix} must be 'live' or 'paper', got '${mode}'`,
    ]);
  }
  return mode;
}

function validatePaperConfig(
  config: ConfigService,
  platformId: PlatformId,
): PaperTradingConfig {
  const suffix = platformId === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET';
  const defaultLatency = platformId === PlatformId.KALSHI ? 150 : 800;
  const defaultSlippage = platformId === PlatformId.KALSHI ? 5 : 15;

  const latencyKey = `PAPER_FILL_LATENCY_MS_${suffix}`;
  const slippageKey = `PAPER_SLIPPAGE_BPS_${suffix}`;

  const fillLatencyMs = Number(
    config.get<string | number>(latencyKey, defaultLatency),
  );
  const slippageBps = Number(
    config.get<string | number>(slippageKey, defaultSlippage),
  );

  const errors: string[] = [];
  if (Number.isNaN(fillLatencyMs)) {
    errors.push(
      `${latencyKey} must be a valid number, got "${config.get<string>(latencyKey)}"`,
    );
  }
  if (Number.isNaN(slippageBps)) {
    errors.push(
      `${slippageKey} must be a valid number, got "${config.get<string>(slippageKey)}"`,
    );
  }
  if (errors.length > 0) {
    throw new ConfigValidationError(
      `Invalid paper trading config for ${suffix}`,
      errors,
    );
  }

  return { platformId, fillLatencyMs, slippageBps };
}

@Module({
  imports: [forwardRef(() => DataIngestionModule), ConfigModule],
  providers: [
    KalshiConnector,
    PolymarketConnector,
    {
      provide: KALSHI_CONNECTOR_TOKEN,
      useFactory: (kalshi: KalshiConnector, config: ConfigService) => {
        const mode = validatePlatformMode(config, PlatformId.KALSHI);
        if (mode === 'paper') {
          const paperConfig = validatePaperConfig(config, PlatformId.KALSHI);
          return new PaperTradingConnector(kalshi, paperConfig);
        }
        return kalshi;
      },
      inject: [KalshiConnector, ConfigService],
    },
    {
      provide: POLYMARKET_CONNECTOR_TOKEN,
      useFactory: (polymarket: PolymarketConnector, config: ConfigService) => {
        const mode = validatePlatformMode(config, PlatformId.POLYMARKET);
        if (mode === 'paper') {
          const paperConfig = validatePaperConfig(
            config,
            PlatformId.POLYMARKET,
          );
          return new PaperTradingConnector(polymarket, paperConfig);
        }
        return polymarket;
      },
      inject: [PolymarketConnector, ConfigService],
    },
  ],
  exports: [
    KalshiConnector,
    PolymarketConnector,
    KALSHI_CONNECTOR_TOKEN,
    POLYMARKET_CONNECTOR_TOKEN,
  ],
})
export class ConnectorModule {}
