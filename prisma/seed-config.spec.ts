import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CONFIG_DEFAULTS } from '../src/common/config/config-defaults.js';

/**
 * Story 10-5.1 AC8 — Seed script tests.
 *
 * The seed script (`prisma/seed-config.ts`) reads env vars
 * and populates the EngineConfig singleton row, setting
 * only NULL columns (idempotent). These tests verify:
 * - NULL columns are seeded from env vars
 * - Existing (non-NULL) values are NOT overwritten
 * - Fresh install creates a new row with all defaults
 * - Boolean env var string→boolean transformation
 * - paperBankrollUsd is NOT seeded
 * - Decimal round-trip correctness
 * - Type set coverage (every CONFIG_DEFAULTS key has a type classification)
 */

// The seed-config module exports a seedConfig function.
// This import will fail until the file is created (TDD RED).
import { seedConfig, DECIMAL_FIELDS, BOOLEAN_FIELDS, FLOAT_FIELDS } from './seed-config.js';

describe('seedConfig()', () => {
  let mockPrisma: {
    engineConfig: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  const defaultEnvValues = {
    POLLING_INTERVAL_MS: '30000',
    DETECTION_MIN_EDGE_THRESHOLD: '0.008',
    DETECTION_GAS_ESTIMATE_USD: '0.30',
    DETECTION_POSITION_SIZE_USD: '300',
    MIN_ANNUALIZED_RETURN: '0.15',
    GAS_BUFFER_PERCENT: '20',
    GAS_POLL_INTERVAL_MS: '30000',
    GAS_POL_PRICE_FALLBACK_USD: '0.40',
    POLYMARKET_SETTLEMENT_GAS_UNITS: '150000',
    EXECUTION_MIN_FILL_RATIO: '0.25',
    RISK_BANKROLL_USD: '10000',
    RISK_MAX_POSITION_PCT: '0.03',
    RISK_MAX_OPEN_PAIRS: '10',
    RISK_DAILY_LOSS_PCT: '0.05',
    CLUSTER_LLM_TIMEOUT_MS: '15000',
    RISK_CLUSTER_HARD_LIMIT_PCT: '0.15',
    RISK_CLUSTER_SOFT_LIMIT_PCT: '0.12',
    RISK_AGGREGATE_CLUSTER_LIMIT_PCT: '0.50',
    TELEGRAM_TEST_ALERT_CRON: '0 8 * * *',
    TELEGRAM_TEST_ALERT_TIMEZONE: 'UTC',
    TELEGRAM_SEND_TIMEOUT_MS: '2000',
    TELEGRAM_MAX_RETRIES: '3',
    TELEGRAM_BUFFER_MAX_SIZE: '100',
    TELEGRAM_CIRCUIT_BREAK_MS: '60000',
    CSV_ENABLED: 'true',
    LLM_PRIMARY_PROVIDER: 'gemini',
    LLM_PRIMARY_MODEL: 'gemini-2.5-flash',
    LLM_ESCALATION_PROVIDER: 'anthropic',
    LLM_ESCALATION_MODEL: 'claude-haiku-4-5-20251001',
    LLM_ESCALATION_MIN: '60',
    LLM_ESCALATION_MAX: '84',
    LLM_AUTO_APPROVE_THRESHOLD: '85',
    LLM_MIN_REVIEW_THRESHOLD: '40',
    LLM_MAX_TOKENS: '1024',
    LLM_TIMEOUT_MS: '30000',
    DISCOVERY_ENABLED: 'true',
    DISCOVERY_RUN_ON_STARTUP: 'false',
    DISCOVERY_CRON_EXPRESSION: '0 0 8,20 * * *',
    DISCOVERY_PREFILTER_THRESHOLD: '0.25',
    DISCOVERY_SETTLEMENT_WINDOW_DAYS: '7',
    DISCOVERY_MAX_CANDIDATES_PER_CONTRACT: '20',
    DISCOVERY_LLM_CONCURRENCY: '10',
    RESOLUTION_POLLER_ENABLED: 'true',
    RESOLUTION_POLLER_CRON_EXPRESSION: '0 0 6 * * *',
    RESOLUTION_POLLER_BATCH_SIZE: '100',
    CALIBRATION_ENABLED: 'true',
    CALIBRATION_CRON_EXPRESSION: '0 0 7 1 */3 *',
    ORDERBOOK_STALENESS_THRESHOLD_MS: '90000',
    WS_STALENESS_THRESHOLD_MS: '60000',
    KALSHI_POLLING_CONCURRENCY: '10',
    POLYMARKET_POLLING_CONCURRENCY: '5',
    AUDIT_LOG_RETENTION_DAYS: '7',
    STRESS_TEST_SCENARIOS: '1000',
    STRESS_TEST_DEFAULT_DAILY_VOL: '0.03',
    STRESS_TEST_MIN_SNAPSHOTS: '30',
    AUTO_UNWIND_ENABLED: 'false',
    AUTO_UNWIND_DELAY_MS: '2000',
    AUTO_UNWIND_MAX_LOSS_PCT: '5',
    ADAPTIVE_SEQUENCING_ENABLED: 'true',
    ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS: '200',
    POLYMARKET_ORDER_POLL_TIMEOUT_MS: '5000',
    POLYMARKET_ORDER_POLL_INTERVAL_MS: '500',
    EXIT_MODE: 'fixed',
    EXIT_EDGE_EVAP_MULTIPLIER: '-1.0',
    EXIT_CONFIDENCE_DROP_PCT: '20',
    EXIT_TIME_DECAY_HORIZON_H: '168',
    EXIT_TIME_DECAY_STEEPNESS: '2.0',
    EXIT_TIME_DECAY_TRIGGER: '0.8',
    EXIT_RISK_BUDGET_PCT: '85',
    EXIT_RISK_RANK_CUTOFF: '1',
    EXIT_MIN_DEPTH: '5',
    EXIT_PROFIT_CAPTURE_RATIO: '0.5',
  };

  beforeEach(() => {
    mockPrisma = {
      engineConfig: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
      },
    };
  });

  it('[P0] should seed all NULL columns from env vars on an existing row', async () => {
    // Existing row with only bankroll set, all new columns NULL
    const existingRow = {
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '10000.00000000' },
      paperBankrollUsd: null,
      pollingIntervalMs: null,
      detectionMinEdgeThreshold: null,
      detectionGasEstimateUsd: null,
      exitMode: null,
      csvEnabled: null,
      discoveryEnabled: null,
      // ... all other Category B fields null
    };
    mockPrisma.engineConfig.findUnique.mockResolvedValue(existingRow);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ ...existingRow });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    // Should have called upsert to set NULL columns
    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalled();
    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];

    // Verify NULL fields are populated from env
    expect(upsertCall.update.pollingIntervalMs).toBe(30000);
    expect(upsertCall.update.exitMode).toBe('fixed');
  });

  it('[P0] should NOT overwrite existing non-NULL values (idempotency)', async () => {
    // Existing row with operator-customized values
    const existingRow = {
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '25000.00000000' },
      paperBankrollUsd: null,
      pollingIntervalMs: 15000, // Operator changed from 30000
      detectionMinEdgeThreshold: { toString: () => '0.01200000' }, // Operator changed
      exitMode: 'model', // Operator changed from 'fixed'
      csvEnabled: false, // Operator disabled
      discoveryEnabled: null, // Still NULL — should be seeded
      riskMaxOpenPairs: 20, // Operator changed
      // ... rest null
    };
    mockPrisma.engineConfig.findUnique.mockResolvedValue(existingRow);
    mockPrisma.engineConfig.upsert.mockResolvedValue(existingRow);

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];

    // Should NOT overwrite existing values
    expect(upsertCall.update).not.toHaveProperty('pollingIntervalMs');
    expect(upsertCall.update).not.toHaveProperty('detectionMinEdgeThreshold');
    expect(upsertCall.update).not.toHaveProperty('exitMode');
    expect(upsertCall.update).not.toHaveProperty('csvEnabled');
    expect(upsertCall.update).not.toHaveProperty('riskMaxOpenPairs');
    expect(upsertCall.update).not.toHaveProperty('bankrollUsd');

    // SHOULD seed the null field
    expect(upsertCall.update.discoveryEnabled).toBe(true);
  });

  it('[P0] should create a new row if none exists (fresh install)', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'new-cfg' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalled();
    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];

    // create payload should include all defaults
    expect(upsertCall.create).toBeDefined();
    expect(upsertCall.create.pollingIntervalMs).toBe(30000);
    expect(upsertCall.create.exitMode).toBe('fixed');
    expect(upsertCall.create.csvEnabled).toBe(true);
    expect(upsertCall.create.discoveryEnabled).toBe(true);
    expect(upsertCall.create.bankrollUsd).toBeDefined();
  });

  it('[P0] should transform boolean env var strings to DB Boolean correctly', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    const envWithBooleans = {
      ...defaultEnvValues,
      CSV_ENABLED: 'true',
      DISCOVERY_ENABLED: 'true',
      DISCOVERY_RUN_ON_STARTUP: 'false',
      RESOLUTION_POLLER_ENABLED: 'true',
      CALIBRATION_ENABLED: 'true',
      AUTO_UNWIND_ENABLED: 'false',
      ADAPTIVE_SEQUENCING_ENABLED: 'true',
    };

    await seedConfig(mockPrisma as any, envWithBooleans);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    const payload = upsertCall.create || upsertCall.update;

    // String 'true' → boolean true
    expect(payload.csvEnabled).toBe(true);
    expect(typeof payload.csvEnabled).toBe('boolean');
    expect(payload.discoveryEnabled).toBe(true);
    expect(typeof payload.discoveryEnabled).toBe('boolean');
    expect(payload.adaptiveSequencingEnabled).toBe(true);

    // String 'false' → boolean false
    expect(payload.discoveryRunOnStartup).toBe(false);
    expect(typeof payload.discoveryRunOnStartup).toBe('boolean');
    expect(payload.autoUnwindEnabled).toBe(false);
    expect(typeof payload.autoUnwindEnabled).toBe('boolean');
  });

  it('[P0] should NOT seed paperBankrollUsd (remains NULL)', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    const createPayload = upsertCall.create;
    const updatePayload = upsertCall.update;

    // paperBankrollUsd should never appear in seed data
    expect(createPayload).not.toHaveProperty('paperBankrollUsd');
    expect(updatePayload).not.toHaveProperty('paperBankrollUsd');
  });

  it('[P0] should round-trip Decimal values correctly (string -> Prisma.Decimal -> string)', async () => {
    // Verify that string env var values survive the round trip through Prisma Decimal
    const decimalFields = [
      { envKey: 'DETECTION_MIN_EDGE_THRESHOLD', dbField: 'detectionMinEdgeThreshold', value: '0.008' },
      { envKey: 'DETECTION_GAS_ESTIMATE_USD', dbField: 'detectionGasEstimateUsd', value: '0.30' },
      { envKey: 'DETECTION_POSITION_SIZE_USD', dbField: 'detectionPositionSizeUsd', value: '300' },
      { envKey: 'MIN_ANNUALIZED_RETURN', dbField: 'minAnnualizedReturn', value: '0.15' },
      { envKey: 'GAS_POL_PRICE_FALLBACK_USD', dbField: 'gasPolPriceFallbackUsd', value: '0.40' },
      { envKey: 'EXECUTION_MIN_FILL_RATIO', dbField: 'executionMinFillRatio', value: '0.25' },
      { envKey: 'RISK_MAX_POSITION_PCT', dbField: 'riskMaxPositionPct', value: '0.03' },
      { envKey: 'RISK_DAILY_LOSS_PCT', dbField: 'riskDailyLossPct', value: '0.05' },
      { envKey: 'RISK_CLUSTER_HARD_LIMIT_PCT', dbField: 'riskClusterHardLimitPct', value: '0.15' },
      { envKey: 'RISK_CLUSTER_SOFT_LIMIT_PCT', dbField: 'riskClusterSoftLimitPct', value: '0.12' },
      { envKey: 'RISK_AGGREGATE_CLUSTER_LIMIT_PCT', dbField: 'riskAggregateClusterLimitPct', value: '0.50' },
      { envKey: 'DISCOVERY_PREFILTER_THRESHOLD', dbField: 'discoveryPrefilterThreshold', value: '0.25' },
      { envKey: 'STRESS_TEST_DEFAULT_DAILY_VOL', dbField: 'stressTestDefaultDailyVol', value: '0.03' },
      { envKey: 'RISK_BANKROLL_USD', dbField: 'bankrollUsd', value: '10000' },
    ];

    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    const payload = upsertCall.create || upsertCall.update;

    for (const { dbField, value } of decimalFields) {
      // The seed should pass a value that when .toString()'d matches the original
      const seededValue = payload[dbField];
      expect(seededValue, `Decimal field ${dbField} should be seeded`).toBeDefined();

      // Seeded value should be a string or Prisma.Decimal-compatible value
      // that preserves the original decimal representation
      const stringValue = typeof seededValue === 'object' && seededValue !== null
        ? seededValue.toString()
        : String(seededValue);

      // The round-trip value should parse to the same number
      expect(
        parseFloat(stringValue),
        `${dbField}: ${stringValue} should parse to ${parseFloat(value)}`,
      ).toBeCloseTo(parseFloat(value), 8);
    }
  });

  it('[P1] should be idempotent — running twice produces the same result', async () => {
    // First run: no row exists
    mockPrisma.engineConfig.findUnique.mockResolvedValueOnce(null);
    const createdRow: Record<string, unknown> = {
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '10000' },
      paperBankrollUsd: null,
      pollingIntervalMs: 30000,
      detectionMinEdgeThreshold: { toString: () => '0.008' },
      detectionGasEstimateUsd: { toString: () => '0.30' },
      detectionPositionSizeUsd: { toString: () => '300' },
      minAnnualizedReturn: { toString: () => '0.15' },
      gasBufferPercent: 20, gasPollIntervalMs: 30000,
      gasPolPriceFallbackUsd: { toString: () => '0.40' },
      polymarketSettlementGasUnits: 150000,
      executionMinFillRatio: { toString: () => '0.25' },
      riskMaxPositionPct: { toString: () => '0.03' },
      riskMaxOpenPairs: 10, riskDailyLossPct: { toString: () => '0.05' },
      clusterLlmTimeoutMs: 15000,
      riskClusterHardLimitPct: { toString: () => '0.15' },
      riskClusterSoftLimitPct: { toString: () => '0.12' },
      riskAggregateClusterLimitPct: { toString: () => '0.50' },
      telegramTestAlertCron: '0 8 * * *', telegramTestAlertTimezone: 'UTC',
      telegramSendTimeoutMs: 2000, telegramMaxRetries: 3,
      telegramBufferMaxSize: 100, telegramCircuitBreakMs: 60000,
      csvEnabled: true,
      llmPrimaryProvider: 'gemini', llmPrimaryModel: 'gemini-2.5-flash',
      llmEscalationProvider: 'anthropic', llmEscalationModel: 'claude-haiku-4-5-20251001',
      llmEscalationMin: 60, llmEscalationMax: 84,
      llmAutoApproveThreshold: 85, llmMinReviewThreshold: 40,
      llmMaxTokens: 1024, llmTimeoutMs: 30000,
      discoveryEnabled: true, discoveryRunOnStartup: false,
      discoveryCronExpression: '0 0 8,20 * * *',
      discoveryPrefilterThreshold: { toString: () => '0.25' },
      discoverySettlementWindowDays: 7, discoveryMaxCandidatesPerContract: 20,
      discoveryLlmConcurrency: 10,
      resolutionPollerEnabled: true, resolutionPollerCronExpression: '0 0 6 * * *',
      resolutionPollerBatchSize: 100,
      calibrationEnabled: true, calibrationCronExpression: '0 0 7 1 */3 *',
      orderbookStalenessThresholdMs: 90000, wsStalenessThresholdMs: 60000,
      kalshiPollingConcurrency: 10, polymarketPollingConcurrency: 5,
      auditLogRetentionDays: 7,
      stressTestScenarios: 1000,
      stressTestDefaultDailyVol: { toString: () => '0.03' },
      stressTestMinSnapshots: 30,
      autoUnwindEnabled: false, autoUnwindDelayMs: 2000, autoUnwindMaxLossPct: 5,
      adaptiveSequencingEnabled: true, adaptiveSequencingLatencyThresholdMs: 200,
      polymarketOrderPollTimeoutMs: 5000, polymarketOrderPollIntervalMs: 500,
      exitMode: 'fixed', exitEdgeEvapMultiplier: -1.0, exitConfidenceDropPct: 20,
      exitTimeDecayHorizonH: 168, exitTimeDecaySteepness: 2.0,
      exitTimeDecayTrigger: 0.8, exitRiskBudgetPct: 85, exitRiskRankCutoff: 1,
      exitMinDepth: 5, exitProfitCaptureRatio: 0.5,
    };
    mockPrisma.engineConfig.upsert.mockResolvedValueOnce(createdRow);

    await seedConfig(mockPrisma as any, defaultEnvValues);

    // Second run: row already exists with all values
    mockPrisma.engineConfig.findUnique.mockResolvedValueOnce(createdRow);
    mockPrisma.engineConfig.upsert.mockResolvedValueOnce(createdRow);

    await seedConfig(mockPrisma as any, defaultEnvValues);

    // The second run should skip the upsert entirely (all non-NULL → empty update)
    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledTimes(1);
  });

  it('[P1] should handle integer env var string-to-number conversion', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    const payload = upsertCall.create || upsertCall.update;

    // Integer fields should be actual numbers, not strings
    expect(payload.pollingIntervalMs).toBe(30000);
    expect(typeof payload.pollingIntervalMs).toBe('number');
    expect(payload.riskMaxOpenPairs).toBe(10);
    expect(typeof payload.riskMaxOpenPairs).toBe('number');
    expect(payload.gasBufferPercent).toBe(20);
    expect(typeof payload.gasBufferPercent).toBe('number');
    expect(payload.telegramSendTimeoutMs).toBe(2000);
    expect(typeof payload.telegramSendTimeoutMs).toBe('number');
  });

  it('[P2] should use singleton key "default" for upsert where clause', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    expect(upsertCall.where).toEqual({ singletonKey: 'default' });
  });

  it('[P1] every CONFIG_DEFAULTS key should be covered by exactly one type set', () => {
    for (const field of Object.keys(CONFIG_DEFAULTS)) {
      const inDecimal = DECIMAL_FIELDS.has(field);
      const inBoolean = BOOLEAN_FIELDS.has(field);
      const inFloat = FLOAT_FIELDS.has(field);
      const classifiedCount = [inDecimal, inBoolean, inFloat].filter(Boolean).length;

      // Field is either in one explicit set, or falls through to int/string
      expect(
        classifiedCount,
        `CONFIG_DEFAULTS key "${field}" is in ${classifiedCount} type sets (must be 0 or 1)`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('[P2] should seed float fields with correct numeric types', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);
    mockPrisma.engineConfig.upsert.mockResolvedValue({ id: 'cfg-new' });

    await seedConfig(mockPrisma as any, defaultEnvValues);

    const upsertCall = mockPrisma.engineConfig.upsert.mock.calls[0][0];
    const payload = upsertCall.create || upsertCall.update;

    // Float fields should be actual numbers
    expect(payload.exitEdgeEvapMultiplier).toBe(-1.0);
    expect(typeof payload.exitEdgeEvapMultiplier).toBe('number');
    expect(payload.exitTimeDecaySteepness).toBe(2.0);
    expect(typeof payload.exitTimeDecaySteepness).toBe('number');
    expect(payload.exitTimeDecayTrigger).toBe(0.8);
    expect(typeof payload.exitTimeDecayTrigger).toBe('number');
    expect(payload.exitProfitCaptureRatio).toBe(0.5);
    expect(typeof payload.exitProfitCaptureRatio).toBe('number');
  });
});
