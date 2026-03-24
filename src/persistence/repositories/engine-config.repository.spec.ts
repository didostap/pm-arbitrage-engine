import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineConfigRepository } from './engine-config.repository.js';
import { PrismaService } from '../../common/prisma.service.js';

/** Mock Prisma Decimal: includes toFixed and d properties so isPrismaDecimal() detects it */
function mockDecimal(value: string) {
  return {
    toString: () => value,
    toFixed: (dp?: number) => parseFloat(value).toFixed(dp),
    d: [1],
  };
}

const mockConfig = {
  id: 'cfg-1',
  singletonKey: 'default',
  bankrollUsd: mockDecimal('10000.00000000'),
  createdAt: new Date('2026-03-14T10:00:00Z'),
  updatedAt: new Date('2026-03-14T10:00:00Z'),
};

describe('EngineConfigRepository', () => {
  let repository: EngineConfigRepository;
  let mockPrisma: {
    engineConfig: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    mockPrisma = {
      engineConfig: {
        findUnique: vi.fn().mockResolvedValue(mockConfig),
        upsert: vi.fn().mockResolvedValue(mockConfig),
      },
    };

    repository = new EngineConfigRepository(
      mockPrisma as unknown as PrismaService,
    );
  });

  it('should get() the singleton config row', async () => {
    const result = await repository.get();

    expect(mockPrisma.engineConfig.findUnique).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
    });
    expect(result).toEqual(mockConfig);
  });

  it('should get() returning null when no row exists', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);

    const result = await repository.get();

    expect(result).toBeNull();
  });

  it('should upsertBankroll() creating row when none exists', async () => {
    await repository.upsertBankroll('15000');

    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
      update: { bankrollUsd: '15000' },
      create: { bankrollUsd: '15000' },
    });
  });

  it('should upsertBankroll() updating existing row', async () => {
    await repository.upsertBankroll('20000.50');

    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
      update: { bankrollUsd: '20000.50' },
      create: { bankrollUsd: '20000.50' },
    });
  });

  it('should upsertBankroll() returning the upserted config', async () => {
    const result = await repository.upsertBankroll('10000');

    expect(result).toEqual(mockConfig);
  });

  // =====================================================================
  // NEW TESTS — Story 10-5.1: getEffectiveConfig() and upsert()
  // These tests are in TDD RED phase — they will fail until implementation.
  // =====================================================================

  describe('getEffectiveConfig()', () => {
    const fullDbRow = {
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: mockDecimal('10000.00000000'),
      paperBankrollUsd: mockDecimal('5000.00000000'),
      // Trading Engine
      pollingIntervalMs: 30000,
      // Edge Detection
      detectionMinEdgeThreshold: mockDecimal('0.00800000'),
      detectionGasEstimateUsd: mockDecimal('0.30000000'),
      detectionPositionSizeUsd: mockDecimal('300.00000000'),
      minAnnualizedReturn: mockDecimal('0.15000000'),
      // Gas Estimation
      gasBufferPercent: 20,
      gasPollIntervalMs: 30000,
      gasPolPriceFallbackUsd: mockDecimal('0.40000000'),
      polymarketSettlementGasUnits: 150000,
      // Execution
      executionMinFillRatio: mockDecimal('0.25000000'),
      dualLegMinDepthRatio: mockDecimal('1.00000000'),
      // Risk Management
      riskMaxPositionPct: mockDecimal('0.03000000'),
      riskMaxOpenPairs: 10,
      riskDailyLossPct: mockDecimal('0.05000000'),
      // Correlation Clusters
      clusterLlmTimeoutMs: 15000,
      riskClusterHardLimitPct: mockDecimal('0.15000000'),
      riskClusterSoftLimitPct: mockDecimal('0.12000000'),
      riskAggregateClusterLimitPct: mockDecimal('0.50000000'),
      // Telegram
      telegramTestAlertCron: '0 8 * * *',
      telegramTestAlertTimezone: 'UTC',
      telegramSendTimeoutMs: 2000,
      telegramMaxRetries: 3,
      telegramBufferMaxSize: 100,
      telegramCircuitBreakMs: 60000,
      // CSV
      csvEnabled: true,
      // LLM Scoring
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
      // Discovery
      discoveryEnabled: true,
      discoveryRunOnStartup: false,
      discoveryCronExpression: '0 0 8,20 * * *',
      discoveryPrefilterThreshold: mockDecimal('0.25000000'),
      discoverySettlementWindowDays: 7,
      discoveryMaxCandidatesPerContract: 20,
      discoveryLlmConcurrency: 10,
      // Resolution Polling
      resolutionPollerEnabled: true,
      resolutionPollerCronExpression: '0 0 6 * * *',
      resolutionPollerBatchSize: 100,
      // Calibration
      calibrationEnabled: true,
      calibrationCronExpression: '0 0 7 1 */3 *',
      // Staleness
      orderbookStalenessThresholdMs: 90000,
      wsStalenessThresholdMs: 60000,
      // Polling Concurrency
      kalshiPollingConcurrency: 10,
      polymarketPollingConcurrency: 5,
      // Audit Log
      auditLogRetentionDays: 7,
      // Stress Testing
      stressTestScenarios: 1000,
      stressTestDefaultDailyVol: mockDecimal('0.03000000'),
      stressTestMinSnapshots: 30,
      // Auto-Unwind
      autoUnwindEnabled: false,
      autoUnwindDelayMs: 2000,
      autoUnwindMaxLossPct: 5,
      // Adaptive Sequencing
      adaptiveSequencingEnabled: true,
      adaptiveSequencingLatencyThresholdMs: 200,
      // Polymarket Order Polling
      polymarketOrderPollTimeoutMs: 5000,
      polymarketOrderPollIntervalMs: 500,
      // Exit Mode
      exitMode: 'fixed',
      exitEdgeEvapMultiplier: -1.0,
      exitConfidenceDropPct: 20,
      exitTimeDecayHorizonH: 168,
      exitTimeDecaySteepness: 2.0,
      exitTimeDecayTrigger: 0.8,
      exitRiskBudgetPct: 85,
      exitRiskRankCutoff: 1,
      exitMinDepth: 5,
      exitProfitCaptureRatio: 0.5,
      pairCooldownMinutes: 30,
      pairMaxConcurrentPositions: 2,
      pairDiversityThreshold: 5,
      // Timestamps
      createdAt: new Date('2026-03-14T10:00:00Z'),
      updatedAt: new Date('2026-03-14T10:00:00Z'),
    };

    const envFallback = {
      bankrollUsd: '10000',
      paperBankrollUsd: null as string | null,
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
      exitProfitCaptureRatio: 0.5,
      pairCooldownMinutes: 30,
      pairMaxConcurrentPositions: 2,
      pairDiversityThreshold: 5,
    };

    it('[P0] should return DB values when all columns are populated', async () => {
      mockPrisma.engineConfig.findUnique.mockResolvedValue(fullDbRow);

      const result = await repository.getEffectiveConfig(envFallback);

      // Verify core fields come from DB
      expect(result.pollingIntervalMs).toBe(30000);
      expect(result.detectionMinEdgeThreshold).toBe('0.00800000');
      expect(result.riskMaxOpenPairs).toBe(10);
      expect(result.exitMode).toBe('fixed');
      expect(result.discoveryEnabled).toBe(true);
      expect(result.csvEnabled).toBe(true);
      expect(result.telegramTestAlertCron).toBe('0 8 * * *');
    });

    it('[P0] should fall back to env var values when all DB columns are NULL', async () => {
      const nullRow = {
        id: 'cfg-1',
        singletonKey: 'default',
        bankrollUsd: mockDecimal('10000.00000000'),
        paperBankrollUsd: null,
        pollingIntervalMs: null,
        detectionMinEdgeThreshold: null,
        detectionGasEstimateUsd: null,
        detectionPositionSizeUsd: null,
        minAnnualizedReturn: null,
        gasBufferPercent: null,
        gasPollIntervalMs: null,
        gasPolPriceFallbackUsd: null,
        polymarketSettlementGasUnits: null,
        executionMinFillRatio: null,
        riskMaxPositionPct: null,
        riskMaxOpenPairs: null,
        riskDailyLossPct: null,
        clusterLlmTimeoutMs: null,
        riskClusterHardLimitPct: null,
        riskClusterSoftLimitPct: null,
        riskAggregateClusterLimitPct: null,
        telegramTestAlertCron: null,
        telegramTestAlertTimezone: null,
        telegramSendTimeoutMs: null,
        telegramMaxRetries: null,
        telegramBufferMaxSize: null,
        telegramCircuitBreakMs: null,
        csvEnabled: null,
        llmPrimaryProvider: null,
        llmPrimaryModel: null,
        llmEscalationProvider: null,
        llmEscalationModel: null,
        llmEscalationMin: null,
        llmEscalationMax: null,
        llmAutoApproveThreshold: null,
        llmMinReviewThreshold: null,
        llmMaxTokens: null,
        llmTimeoutMs: null,
        discoveryEnabled: null,
        discoveryRunOnStartup: null,
        discoveryCronExpression: null,
        discoveryPrefilterThreshold: null,
        discoverySettlementWindowDays: null,
        discoveryMaxCandidatesPerContract: null,
        discoveryLlmConcurrency: null,
        resolutionPollerEnabled: null,
        resolutionPollerCronExpression: null,
        resolutionPollerBatchSize: null,
        calibrationEnabled: null,
        calibrationCronExpression: null,
        orderbookStalenessThresholdMs: null,
        wsStalenessThresholdMs: null,
        kalshiPollingConcurrency: null,
        polymarketPollingConcurrency: null,
        auditLogRetentionDays: null,
        stressTestScenarios: null,
        stressTestDefaultDailyVol: null,
        stressTestMinSnapshots: null,
        autoUnwindEnabled: null,
        autoUnwindDelayMs: null,
        autoUnwindMaxLossPct: null,
        adaptiveSequencingEnabled: null,
        adaptiveSequencingLatencyThresholdMs: null,
        polymarketOrderPollTimeoutMs: null,
        polymarketOrderPollIntervalMs: null,
        exitMode: null,
        exitEdgeEvapMultiplier: null,
        exitConfidenceDropPct: null,
        exitTimeDecayHorizonH: null,
        exitTimeDecaySteepness: null,
        exitTimeDecayTrigger: null,
        exitRiskBudgetPct: null,
        exitRiskRankCutoff: null,
        exitMinDepth: null,
        exitProfitCaptureRatio: null,
        createdAt: new Date('2026-03-14T10:00:00Z'),
        updatedAt: new Date('2026-03-14T10:00:00Z'),
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(nullRow);

      const result = await repository.getEffectiveConfig(envFallback);

      // All values should fall back to envFallback
      expect(result.pollingIntervalMs).toBe(30000);
      expect(result.detectionMinEdgeThreshold).toBe('0.008');
      expect(result.riskMaxOpenPairs).toBe(10);
      expect(result.discoveryEnabled).toBe(true);
      expect(result.csvEnabled).toBe(true);
      expect(result.exitMode).toBe('fixed');
      expect(result.telegramTestAlertCron).toBe('0 8 * * *');
      expect(result.autoUnwindEnabled).toBe(false);
      expect(result.adaptiveSequencingEnabled).toBe(true);
    });

    it('[P0] should mix DB values and env fallbacks when some columns are NULL', async () => {
      const mixedRow = {
        id: 'cfg-1',
        singletonKey: 'default',
        bankrollUsd: mockDecimal('25000.00000000'),
        paperBankrollUsd: null,
        // Set some non-null, leave others null
        pollingIntervalMs: 15000, // DB override
        detectionMinEdgeThreshold: mockDecimal('0.01200000'), // DB override
        detectionGasEstimateUsd: null, // fallback
        detectionPositionSizeUsd: null, // fallback
        minAnnualizedReturn: mockDecimal('0.20000000'), // DB override
        gasBufferPercent: null,
        gasPollIntervalMs: null,
        gasPolPriceFallbackUsd: null,
        polymarketSettlementGasUnits: null,
        executionMinFillRatio: null,
        riskMaxPositionPct: null,
        riskMaxOpenPairs: 20, // DB override
        riskDailyLossPct: null,
        clusterLlmTimeoutMs: null,
        riskClusterHardLimitPct: null,
        riskClusterSoftLimitPct: null,
        riskAggregateClusterLimitPct: null,
        telegramTestAlertCron: null,
        telegramTestAlertTimezone: null,
        telegramSendTimeoutMs: null,
        telegramMaxRetries: null,
        telegramBufferMaxSize: null,
        telegramCircuitBreakMs: null,
        csvEnabled: false, // DB override
        llmPrimaryProvider: null,
        llmPrimaryModel: null,
        llmEscalationProvider: null,
        llmEscalationModel: null,
        llmEscalationMin: null,
        llmEscalationMax: null,
        llmAutoApproveThreshold: null,
        llmMinReviewThreshold: null,
        llmMaxTokens: null,
        llmTimeoutMs: null,
        discoveryEnabled: null,
        discoveryRunOnStartup: null,
        discoveryCronExpression: null,
        discoveryPrefilterThreshold: null,
        discoverySettlementWindowDays: null,
        discoveryMaxCandidatesPerContract: null,
        discoveryLlmConcurrency: null,
        resolutionPollerEnabled: null,
        resolutionPollerCronExpression: null,
        resolutionPollerBatchSize: null,
        calibrationEnabled: null,
        calibrationCronExpression: null,
        orderbookStalenessThresholdMs: null,
        wsStalenessThresholdMs: null,
        kalshiPollingConcurrency: null,
        polymarketPollingConcurrency: null,
        auditLogRetentionDays: null,
        stressTestScenarios: null,
        stressTestDefaultDailyVol: null,
        stressTestMinSnapshots: null,
        autoUnwindEnabled: null,
        autoUnwindDelayMs: null,
        autoUnwindMaxLossPct: null,
        adaptiveSequencingEnabled: null,
        adaptiveSequencingLatencyThresholdMs: null,
        polymarketOrderPollTimeoutMs: null,
        polymarketOrderPollIntervalMs: null,
        exitMode: 'model', // DB override
        exitEdgeEvapMultiplier: null,
        exitConfidenceDropPct: null,
        exitTimeDecayHorizonH: null,
        exitTimeDecaySteepness: null,
        exitTimeDecayTrigger: null,
        exitRiskBudgetPct: null,
        exitRiskRankCutoff: null,
        exitMinDepth: null,
        exitProfitCaptureRatio: null,
        createdAt: new Date('2026-03-14T10:00:00Z'),
        updatedAt: new Date('2026-03-14T10:00:00Z'),
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(mixedRow);

      const result = await repository.getEffectiveConfig(envFallback);

      // DB overrides
      expect(result.pollingIntervalMs).toBe(15000);
      expect(result.detectionMinEdgeThreshold).toBe('0.01200000');
      expect(result.minAnnualizedReturn).toBe('0.20000000');
      expect(result.riskMaxOpenPairs).toBe(20);
      expect(result.csvEnabled).toBe(false);
      expect(result.exitMode).toBe('model');
      expect(result.bankrollUsd).toBe('25000.00000000');

      // Env fallbacks
      expect(result.detectionGasEstimateUsd).toBe('0.30');
      expect(result.detectionPositionSizeUsd).toBe('300');
      expect(result.gasBufferPercent).toBe(20);
      expect(result.discoveryEnabled).toBe(true);
      expect(result.telegramTestAlertCron).toBe('0 8 * * *');
      expect(result.autoUnwindEnabled).toBe(false);
    });

    it('[P0] should convert Prisma.Decimal values to plain string (no scientific notation)', async () => {
      const rowWithDecimals = {
        ...fullDbRow,
        detectionMinEdgeThreshold: mockDecimal('0.00800000'),
        riskMaxPositionPct: mockDecimal('0.03000000'),
        stressTestDefaultDailyVol: mockDecimal('0.03000000'),
        gasPolPriceFallbackUsd: mockDecimal('0.40000000'),
        discoveryPrefilterThreshold: mockDecimal('0.25000000'),
        riskClusterHardLimitPct: mockDecimal('0.15000000'),
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(rowWithDecimals);

      const result = await repository.getEffectiveConfig(envFallback);

      // Decimal fields should be plain strings, not scientific notation
      expect(result.detectionMinEdgeThreshold).toBe('0.00800000');
      expect(typeof result.detectionMinEdgeThreshold).toBe('string');
      expect(result.riskMaxPositionPct).toBe('0.03000000');
      expect(typeof result.riskMaxPositionPct).toBe('string');
      expect(result.stressTestDefaultDailyVol).toBe('0.03000000');
      expect(typeof result.stressTestDefaultDailyVol).toBe('string');
      // Ensure no scientific notation (e.g., "8e-3" instead of "0.00800000")
      expect(result.detectionMinEdgeThreshold).not.toMatch(/[eE]/);
      expect(result.gasPolPriceFallbackUsd).not.toMatch(/[eE]/);
    });

    it('[P1] should include bankrollUsd and paperBankrollUsd in output', async () => {
      mockPrisma.engineConfig.findUnique.mockResolvedValue(fullDbRow);

      const result = await repository.getEffectiveConfig(envFallback);

      expect(result.bankrollUsd).toBe('10000.00000000');
      expect(result.paperBankrollUsd).toBe('5000.00000000');
    });

    it('[P1] should return null for paperBankrollUsd when DB column is NULL', async () => {
      const rowNullPaper = {
        ...fullDbRow,
        paperBankrollUsd: null,
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(rowNullPaper);

      const result = await repository.getEffectiveConfig(envFallback);

      // paperBankrollUsd has no env fallback — stays null
      expect(result.paperBankrollUsd).toBeNull();
    });

    it('[P0] should perform a single DB read (findUnique called once)', async () => {
      mockPrisma.engineConfig.findUnique.mockResolvedValue(fullDbRow);

      await repository.getEffectiveConfig(envFallback);

      expect(mockPrisma.engineConfig.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.engineConfig.findUnique).toHaveBeenCalledWith({
        where: { singletonKey: 'default' },
      });
    });

    it('[P1] should return env fallback for all fields when no DB row exists', async () => {
      mockPrisma.engineConfig.findUnique.mockResolvedValue(null);

      const result = await repository.getEffectiveConfig(envFallback);

      expect(result.pollingIntervalMs).toBe(30000);
      expect(result.detectionMinEdgeThreshold).toBe('0.008');
      expect(result.bankrollUsd).toBe('10000');
      expect(result.exitMode).toBe('fixed');
      expect(result.discoveryEnabled).toBe(true);
    });

    it('[P2] should handle boolean false DB values correctly (not treated as NULL)', async () => {
      const rowWithFalseBooleans = {
        ...fullDbRow,
        csvEnabled: false,
        discoveryEnabled: false,
        autoUnwindEnabled: false,
        adaptiveSequencingEnabled: false,
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(
        rowWithFalseBooleans,
      );

      const result = await repository.getEffectiveConfig(envFallback);

      // false is a valid DB value, not NULL — should NOT fall back to env
      expect(result.csvEnabled).toBe(false);
      expect(result.discoveryEnabled).toBe(false);
      expect(result.autoUnwindEnabled).toBe(false);
      expect(result.adaptiveSequencingEnabled).toBe(false);
    });

    it('[P2] should handle zero integer DB values correctly (not treated as NULL)', async () => {
      const rowWithZeros = {
        ...fullDbRow,
        telegramMaxRetries: 0,
        auditLogRetentionDays: 0,
      };
      mockPrisma.engineConfig.findUnique.mockResolvedValue(rowWithZeros);

      const result = await repository.getEffectiveConfig(envFallback);

      // 0 is a valid DB value, not NULL — should NOT fall back to env
      expect(result.telegramMaxRetries).toBe(0);
      expect(result.auditLogRetentionDays).toBe(0);
    });
  });

  describe('upsert()', () => {
    it('[P0] should accept partial updates and only update specified fields', async () => {
      const partialUpdate = {
        pollingIntervalMs: 15000,
        detectionMinEdgeThreshold: '0.012',
      };
      mockPrisma.engineConfig.upsert.mockResolvedValue({
        ...mockConfig,
        ...partialUpdate,
      });

      await repository.upsert(partialUpdate);

      expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { singletonKey: 'default' },
          update: partialUpdate,
        }),
      );
    });

    it('[P0] should not modify fields that were not passed in the partial update', async () => {
      const partialUpdate = {
        riskMaxOpenPairs: 20,
      };
      mockPrisma.engineConfig.upsert.mockResolvedValue(mockConfig);

      await repository.upsert(partialUpdate);

      const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };
      // Only riskMaxOpenPairs should be in the update payload
      expect(upsertCall.update).toEqual({ riskMaxOpenPairs: 20 });
      // Fields not passed should NOT appear in the update
      expect(upsertCall.update).not.toHaveProperty('pollingIntervalMs');
      expect(upsertCall.update).not.toHaveProperty('exitMode');
      expect(upsertCall.update).not.toHaveProperty('bankrollUsd');
    });

    it('[P1] should accept boolean field updates', async () => {
      const partialUpdate = {
        csvEnabled: false,
        discoveryEnabled: true,
        autoUnwindEnabled: true,
      };
      mockPrisma.engineConfig.upsert.mockResolvedValue(mockConfig);

      await repository.upsert(partialUpdate);

      const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };
      expect(upsertCall.update.csvEnabled).toBe(false);
      expect(upsertCall.update.discoveryEnabled).toBe(true);
      expect(upsertCall.update.autoUnwindEnabled).toBe(true);
    });

    it('[P1] should accept string field updates', async () => {
      const partialUpdate = {
        exitMode: 'model',
        llmPrimaryProvider: 'anthropic',
        discoveryCronExpression: '0 0 6,18 * * *',
      };
      mockPrisma.engineConfig.upsert.mockResolvedValue(mockConfig);

      await repository.upsert(partialUpdate);

      const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };
      expect(upsertCall.update.exitMode).toBe('model');
      expect(upsertCall.update.llmPrimaryProvider).toBe('anthropic');
      expect(upsertCall.update.discoveryCronExpression).toBe('0 0 6,18 * * *');
    });

    it('[P1] should return the upserted EngineConfig row', async () => {
      const updated = { ...mockConfig, pollingIntervalMs: 15000 };
      mockPrisma.engineConfig.upsert.mockResolvedValue(updated);

      const result = await repository.upsert({ pollingIntervalMs: 15000 });

      expect(result).toEqual(updated);
    });

    it('[P0] should preserve backward compatibility with upsertBankroll()', async () => {
      // Existing upsertBankroll still works after adding upsert()
      mockPrisma.engineConfig.upsert.mockResolvedValue(mockConfig);

      await repository.upsertBankroll('30000');

      expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith({
        where: { singletonKey: 'default' },
        update: { bankrollUsd: '30000' },
        create: { bankrollUsd: '30000' },
      });
    });

    it('[P2] should accept an empty partial update without error', async () => {
      mockPrisma.engineConfig.upsert.mockResolvedValue(mockConfig);

      const result = await repository.upsert({});

      expect(result).toEqual(mockConfig);
    });
  });
});
