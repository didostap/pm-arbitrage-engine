import { Injectable } from '@nestjs/common';
import { EngineConfig, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';
import {
  EffectiveConfig,
  EngineConfigUpdateInput,
} from '../../common/config/effective-config.types.js';
import {
  CONFIG_DEFAULTS,
  ConfigDefaultEntry,
} from '../../common/config/config-defaults.js';

/**
 * Detect Prisma Decimal objects. Prisma.Decimal carries `d`, `e`, `s` properties
 * and a `toFixed` method — distinguishes from Date, Array, plain objects, etc.
 */
function isPrismaDecimal(value: unknown): value is { toString(): string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['toFixed'] === 'function' &&
    'd' in value
  );
}

/**
 * Pure function: resolves a single config field from DB row → env fallback.
 * Uses strict null check (=== null || === undefined) so that `false` and `0` are valid DB values.
 * Prisma.Decimal values are converted to plain strings via .toString().
 */
function resolveField(
  dbValue: unknown,
  fallbackValue: unknown,
): string | number | boolean | null {
  if (dbValue === null || dbValue === undefined) {
    return fallbackValue as string | number | boolean | null;
  }
  // Prisma.Decimal → plain string (no scientific notation)
  if (isPrismaDecimal(dbValue)) {
    return (dbValue as { toString(): string }).toString();
  }
  return dbValue as string | number | boolean;
}

/**
 * Build an EffectiveConfig from a DB row (or null) + env fallbacks.
 * When a DB column is NULL or missing, falls back to envFallback → CONFIG_DEFAULTS.
 */
function buildEffectiveConfig(
  row: EngineConfig | null,
  envFallback: Partial<EffectiveConfig>,
): EffectiveConfig {
  const defaults: Record<string, ConfigDefaultEntry> = CONFIG_DEFAULTS;
  const env = envFallback as Record<string, unknown>;
  const dbRow = row as Record<string, unknown> | null;

  // Helper: resolve one field through the 3-tier chain
  const resolve = (field: string): string | number | boolean | null => {
    const dbValue = dbRow ? dbRow[field] : undefined;
    const fallback = env[field] ?? defaults[field]?.defaultValue ?? null;
    return resolveField(dbValue, fallback);
  };

  return {
    // Bankroll
    bankrollUsd: resolve('bankrollUsd') as string,
    paperBankrollUsd: resolve('paperBankrollUsd') as string | null,
    // Trading Engine
    pollingIntervalMs: resolve('pollingIntervalMs') as number,
    // Edge Detection
    detectionMinEdgeThreshold: resolve('detectionMinEdgeThreshold') as string,
    detectionGasEstimateUsd: resolve('detectionGasEstimateUsd') as string,
    detectionPositionSizeUsd: resolve('detectionPositionSizeUsd') as string,
    minAnnualizedReturn: resolve('minAnnualizedReturn') as string,
    detectionMinFillRatio: resolve('detectionMinFillRatio') as string,
    depthEdgeScalingFactor: resolve('depthEdgeScalingFactor') as string,
    maxDynamicEdgeThreshold: resolve('maxDynamicEdgeThreshold') as string,
    // Gas Estimation
    gasBufferPercent: resolve('gasBufferPercent') as number,
    gasPollIntervalMs: resolve('gasPollIntervalMs') as number,
    gasPolPriceFallbackUsd: resolve('gasPolPriceFallbackUsd') as string,
    polymarketSettlementGasUnits: resolve(
      'polymarketSettlementGasUnits',
    ) as number,
    // Execution
    executionMinFillRatio: resolve('executionMinFillRatio') as string,
    dualLegMinDepthRatio: resolve('dualLegMinDepthRatio') as string,
    // Risk Management
    riskMaxPositionPct: resolve('riskMaxPositionPct') as string,
    riskMaxOpenPairs: resolve('riskMaxOpenPairs') as number,
    riskDailyLossPct: resolve('riskDailyLossPct') as string,
    // Correlation Clusters
    clusterLlmTimeoutMs: resolve('clusterLlmTimeoutMs') as number,
    riskClusterHardLimitPct: resolve('riskClusterHardLimitPct') as string,
    riskClusterSoftLimitPct: resolve('riskClusterSoftLimitPct') as string,
    riskAggregateClusterLimitPct: resolve(
      'riskAggregateClusterLimitPct',
    ) as string,
    // Telegram
    telegramTestAlertCron: resolve('telegramTestAlertCron') as string,
    telegramTestAlertTimezone: resolve('telegramTestAlertTimezone') as string,
    telegramSendTimeoutMs: resolve('telegramSendTimeoutMs') as number,
    telegramMaxRetries: resolve('telegramMaxRetries') as number,
    telegramBufferMaxSize: resolve('telegramBufferMaxSize') as number,
    telegramCircuitBreakMs: resolve('telegramCircuitBreakMs') as number,
    // CSV
    csvEnabled: resolve('csvEnabled') as boolean,
    // LLM Scoring
    llmPrimaryProvider: resolve('llmPrimaryProvider') as string,
    llmPrimaryModel: resolve('llmPrimaryModel') as string,
    llmEscalationProvider: resolve('llmEscalationProvider') as string,
    llmEscalationModel: resolve('llmEscalationModel') as string,
    llmEscalationMin: resolve('llmEscalationMin') as number,
    llmEscalationMax: resolve('llmEscalationMax') as number,
    llmAutoApproveThreshold: resolve('llmAutoApproveThreshold') as number,
    llmMinReviewThreshold: resolve('llmMinReviewThreshold') as number,
    llmMaxTokens: resolve('llmMaxTokens') as number,
    llmTimeoutMs: resolve('llmTimeoutMs') as number,
    // Discovery
    discoveryEnabled: resolve('discoveryEnabled') as boolean,
    discoveryRunOnStartup: resolve('discoveryRunOnStartup') as boolean,
    discoveryCronExpression: resolve('discoveryCronExpression') as string,
    discoveryPrefilterThreshold: resolve(
      'discoveryPrefilterThreshold',
    ) as string,
    discoverySettlementWindowDays: resolve(
      'discoverySettlementWindowDays',
    ) as number,
    discoveryMaxCandidatesPerContract: resolve(
      'discoveryMaxCandidatesPerContract',
    ) as number,
    discoveryLlmConcurrency: resolve('discoveryLlmConcurrency') as number,
    // Resolution Polling
    resolutionPollerEnabled: resolve('resolutionPollerEnabled') as boolean,
    resolutionPollerCronExpression: resolve(
      'resolutionPollerCronExpression',
    ) as string,
    resolutionPollerBatchSize: resolve('resolutionPollerBatchSize') as number,
    // Calibration
    calibrationEnabled: resolve('calibrationEnabled') as boolean,
    calibrationCronExpression: resolve('calibrationCronExpression') as string,
    // Staleness Thresholds
    orderbookStalenessThresholdMs: resolve(
      'orderbookStalenessThresholdMs',
    ) as number,
    wsStalenessThresholdMs: resolve('wsStalenessThresholdMs') as number,
    // Polling Concurrency
    kalshiPollingConcurrency: resolve('kalshiPollingConcurrency') as number,
    polymarketPollingConcurrency: resolve(
      'polymarketPollingConcurrency',
    ) as number,
    // Audit Log
    auditLogRetentionDays: resolve('auditLogRetentionDays') as number,
    // Stress Testing
    stressTestScenarios: resolve('stressTestScenarios') as number,
    stressTestDefaultDailyVol: resolve('stressTestDefaultDailyVol') as string,
    stressTestMinSnapshots: resolve('stressTestMinSnapshots') as number,
    // Auto-Unwind
    autoUnwindEnabled: resolve('autoUnwindEnabled') as boolean,
    autoUnwindDelayMs: resolve('autoUnwindDelayMs') as number,
    autoUnwindMaxLossPct: resolve('autoUnwindMaxLossPct') as number,
    // Adaptive Sequencing
    adaptiveSequencingEnabled: resolve('adaptiveSequencingEnabled') as boolean,
    adaptiveSequencingLatencyThresholdMs: resolve(
      'adaptiveSequencingLatencyThresholdMs',
    ) as number,
    // Polymarket Order Polling
    polymarketOrderPollTimeoutMs: resolve(
      'polymarketOrderPollTimeoutMs',
    ) as number,
    polymarketOrderPollIntervalMs: resolve(
      'polymarketOrderPollIntervalMs',
    ) as number,
    // Pair Concentration Limits
    pairCooldownMinutes: resolve('pairCooldownMinutes') as number,
    pairMaxConcurrentPositions: resolve('pairMaxConcurrentPositions') as number,
    pairDiversityThreshold: resolve('pairDiversityThreshold') as number,
    // Exit Mode
    exitMode: resolve('exitMode') as string,
    exitEdgeEvapMultiplier: resolve('exitEdgeEvapMultiplier') as number,
    exitConfidenceDropPct: resolve('exitConfidenceDropPct') as number,
    exitTimeDecayHorizonH: resolve('exitTimeDecayHorizonH') as number,
    exitTimeDecaySteepness: resolve('exitTimeDecaySteepness') as number,
    exitTimeDecayTrigger: resolve('exitTimeDecayTrigger') as number,
    exitRiskBudgetPct: resolve('exitRiskBudgetPct') as number,
    exitRiskRankCutoff: resolve('exitRiskRankCutoff') as number,
    exitMinDepth: resolve('exitMinDepth') as number,
    exitDepthSlippageTolerance: resolve('exitDepthSlippageTolerance') as number,
    exitMaxChunkSize: resolve('exitMaxChunkSize') as number,
    exitProfitCaptureRatio: resolve('exitProfitCaptureRatio') as number,
  };
}

@Injectable()
export class EngineConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<EngineConfig | null> {
    return this.prisma.engineConfig.findUnique({
      where: { singletonKey: 'default' },
    });
  }

  async upsertBankroll(
    bankrollUsd: Prisma.Decimal | string,
  ): Promise<EngineConfig> {
    return this.prisma.engineConfig.upsert({
      where: { singletonKey: 'default' },
      update: { bankrollUsd },
      create: { bankrollUsd },
    });
  }

  /**
   * Returns a fully-resolved config where every field has a concrete value.
   * DB value → env var fallback (passed in by caller). Single DB read.
   */
  async getEffectiveConfig(
    envFallback: Partial<EffectiveConfig>,
  ): Promise<EffectiveConfig> {
    const row = await this.prisma.engineConfig.findUnique({
      where: { singletonKey: 'default' },
    });

    return buildEffectiveConfig(row, envFallback);
  }

  /**
   * Bulk update EngineConfig fields. Partial — only updates specified fields.
   * Story 10-5-2 will use this for CRUD endpoints.
   */
  async upsert(fields: EngineConfigUpdateInput): Promise<EngineConfig> {
    return this.prisma.engineConfig.upsert({
      where: { singletonKey: 'default' },
      update: fields,
      create: {
        bankrollUsd:
          fields.bankrollUsd ?? CONFIG_DEFAULTS.bankrollUsd.defaultValue,
        ...fields,
      } as Prisma.EngineConfigCreateInput,
    });
  }
}
