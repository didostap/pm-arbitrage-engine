import { ConfigService } from '@nestjs/config';
import { RiskConfig } from '../../common/types/risk.type';
import { ConfigValidationError } from '../../common/errors/config-validation-error';
import { CONFIG_DEFAULTS } from '../../common/config/config-defaults';
import type { EffectiveConfig } from '../../common/config/effective-config.types';

/**
 * Validates risk config values and returns a complete RiskConfig.
 * Throws ConfigValidationError on invalid values.
 */
export function validateRiskConfigValues(
  config: Partial<RiskConfig> | undefined,
  configService: ConfigService,
): RiskConfig {
  const bankroll = config?.bankrollUsd;
  const maxPct = Number(
    configService.get<string | number>('RISK_MAX_POSITION_PCT', 0.03),
  );
  const maxPairs = Number(
    configService.get<string | number>('RISK_MAX_OPEN_PAIRS', 10),
  );
  const dailyLossPct = Number(
    configService.get<string | number>('RISK_DAILY_LOSS_PCT', 0.05),
  );
  if (!bankroll || bankroll <= 0)
    throw new ConfigValidationError(
      'RISK_BANKROLL_USD must be a positive number',
      ['RISK_BANKROLL_USD is invalid or missing'],
    );
  if (maxPct <= 0 || maxPct > 1)
    throw new ConfigValidationError(
      'RISK_MAX_POSITION_PCT must be between 0 and 1',
      ['RISK_MAX_POSITION_PCT is out of range'],
    );
  if (maxPairs <= 0 || !Number.isInteger(maxPairs))
    throw new ConfigValidationError(
      'RISK_MAX_OPEN_PAIRS must be a positive integer',
      ['RISK_MAX_OPEN_PAIRS is invalid'],
    );
  if (dailyLossPct <= 0 || dailyLossPct > 1)
    throw new ConfigValidationError(
      'RISK_DAILY_LOSS_PCT must be between 0 (exclusive) and 1 (inclusive)',
      ['RISK_DAILY_LOSS_PCT is out of range'],
    );
  return {
    bankrollUsd: bankroll,
    paperBankrollUsd: config?.paperBankrollUsd,
    maxPositionPct: maxPct,
    maxOpenPairs: maxPairs,
    dailyLossPct,
  };
}

/**
 * Builds env fallback config for hot-reload by reading env vars for each CONFIG_DEFAULTS entry.
 */
export function buildEnvFallback(
  configService: ConfigService,
): Partial<EffectiveConfig> {
  const fallback: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(CONFIG_DEFAULTS)) {
    const envValue = configService.get<unknown>(entry.envKey);
    if (envValue !== undefined) fallback[field] = envValue;
  }
  return fallback as Partial<EffectiveConfig>;
}
