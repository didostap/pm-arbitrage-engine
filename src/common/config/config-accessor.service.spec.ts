import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConfigAccessor } from './config-accessor.service.js';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository.js';
import type { EffectiveConfig } from './effective-config.types.js';

function buildMockConfig(
  overrides: Partial<EffectiveConfig> = {},
): EffectiveConfig {
  return {
    bankrollUsd: '10000',
    paperBankrollUsd: null,
    pollingIntervalMs: 30000,
    detectionMinEdgeThreshold: '0.008',
    detectionGasEstimateUsd: '0.30',
    detectionPositionSizeUsd: '300',
    minAnnualizedReturn: '0.15',
    gasBufferPercent: 20,
    gasPollIntervalMs: 30000,
    gasPolPriceFallbackUsd: '0.40',
    polymarketSettlementGasUnits: 150000,
    executionMinFillRatio: '0.25',
    riskMaxPositionPct: '0.03',
    riskMaxOpenPairs: 10,
    riskDailyLossPct: '0.05',
    clusterLlmTimeoutMs: 15000,
    riskClusterHardLimitPct: '0.15',
    riskClusterSoftLimitPct: '0.12',
    riskAggregateClusterLimitPct: '0.50',
    telegramTestAlertCron: '0 8 * * *',
    telegramTestAlertTimezone: 'UTC',
    telegramSendTimeoutMs: 2000,
    telegramMaxRetries: 3,
    telegramBufferMaxSize: 100,
    telegramCircuitBreakMs: 60000,
    csvEnabled: true,
    llmPrimaryProvider: 'gemini',
    llmPrimaryModel: 'gemini-2.5-flash',
    llmEscalationProvider: 'anthropic',
    llmEscalationModel: 'claude-haiku-4-5-20251001',
    llmEscalationMin: 60,
    llmEscalationMax: 84,
    llmAutoApproveThreshold: 85,
    llmMinReviewThreshold: 40,
    llmMaxTokens: 1024,
    llmTimeoutMs: 30000,
    discoveryEnabled: true,
    discoveryRunOnStartup: false,
    discoveryCronExpression: '0 0 8,20 * * *',
    discoveryPrefilterThreshold: '0.25',
    discoverySettlementWindowDays: 7,
    discoveryMaxCandidatesPerContract: 20,
    discoveryLlmConcurrency: 10,
    resolutionPollerEnabled: true,
    resolutionPollerCronExpression: '0 0 6 * * *',
    resolutionPollerBatchSize: 100,
    calibrationEnabled: true,
    calibrationCronExpression: '0 0 7 1 */3 *',
    orderbookStalenessThresholdMs: 90000,
    wsStalenessThresholdMs: 60000,
    kalshiPollingConcurrency: 10,
    polymarketPollingConcurrency: 5,
    auditLogRetentionDays: 7,
    stressTestScenarios: 1000,
    stressTestDefaultDailyVol: '0.03',
    stressTestMinSnapshots: 30,
    autoUnwindEnabled: false,
    autoUnwindDelayMs: 2000,
    autoUnwindMaxLossPct: 5,
    adaptiveSequencingEnabled: true,
    adaptiveSequencingLatencyThresholdMs: 200,
    polymarketOrderPollTimeoutMs: 5000,
    polymarketOrderPollIntervalMs: 500,
    exitMode: 'fixed',
    exitEdgeEvapMultiplier: -1.0,
    exitConfidenceDropPct: 20,
    exitTimeDecayHorizonH: 168,
    exitTimeDecaySteepness: 2.0,
    exitTimeDecayTrigger: 0.8,
    exitRiskBudgetPct: 85,
    exitRiskRankCutoff: 1,
    exitMinDepth: 5,
    exitDepthSlippageTolerance: 0.02,
    exitProfitCaptureRatio: 0.5,
    ...overrides,
  };
}

describe('ConfigAccessor', () => {
  let accessor: ConfigAccessor;
  let repo: { getEffectiveConfig: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      getEffectiveConfig: vi.fn().mockResolvedValue(buildMockConfig()),
    };
    const configService = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    accessor = new ConfigAccessor(
      repo as unknown as EngineConfigRepository,
      configService,
    );
    await accessor.onModuleInit();
  });

  it('get() returns cached EffectiveConfig', async () => {
    const config = await accessor.get();
    expect(config.bankrollUsd).toBe('10000');
    expect(config.exitMode).toBe('fixed');
    // Only one DB call during init
    expect(repo.getEffectiveConfig).toHaveBeenCalledTimes(1);
  });

  it('getField() returns single field value', async () => {
    const value = await accessor.getField('riskMaxOpenPairs');
    expect(value).toBe(10);
  });

  it('handleSettingsUpdated() refreshes cache', async () => {
    const updatedConfig = buildMockConfig({ riskMaxOpenPairs: 20 });
    repo.getEffectiveConfig.mockResolvedValueOnce(updatedConfig);

    await accessor.handleSettingsUpdated();

    const config = await accessor.get();
    expect(config.riskMaxOpenPairs).toBe(20);
    // init + refresh = 2 calls
    expect(repo.getEffectiveConfig).toHaveBeenCalledTimes(2);
  });

  it('handleBankrollUpdated() refreshes cache', async () => {
    const updatedConfig = buildMockConfig({ bankrollUsd: '20000' });
    repo.getEffectiveConfig.mockResolvedValueOnce(updatedConfig);

    await accessor.handleBankrollUpdated();

    const config = await accessor.get();
    expect(config.bankrollUsd).toBe('20000');
  });

  it('get() throws SystemHealthError when refresh fails and cache is empty', async () => {
    // Create a fresh accessor (no onModuleInit — cache is null)
    const failingRepo = {
      getEffectiveConfig: vi.fn().mockRejectedValue(new Error('DB down')),
    };
    const configService = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const freshAccessor = new ConfigAccessor(
      failingRepo as unknown as EngineConfigRepository,
      configService,
    );

    await expect(freshAccessor.get()).rejects.toThrow(
      /ConfigAccessor: failed to load EffectiveConfig from DB/,
    );
  });
});
