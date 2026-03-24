import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULTS } from './config-defaults.js';
import { envSchema } from './env.schema.js';
import type { EffectiveConfig } from './effective-config.types.js';

/**
 * Story 10-5.1 AC6 — CONFIG_DEFAULTS mapping tests.
 *
 * CONFIG_DEFAULTS maps each EngineConfig DB field name to its
 * corresponding env var key and Zod default value. It is the
 * single source of truth for the fallback chain:
 *   DB value → env var → Zod default.
 *
 * These tests verify mapping completeness, structure, and correctness.
 */

/** All 71 Category B fields + 2 existing bankroll fields = 73 total */
const CATEGORY_B_FIELDS: string[] = [
  // Trading Engine
  'pollingIntervalMs',
  // Edge Detection
  'detectionMinEdgeThreshold',
  'detectionGasEstimateUsd',
  'detectionPositionSizeUsd',
  'minAnnualizedReturn',
  // Detection Depth
  'depthEdgeScalingFactor',
  'maxDynamicEdgeThreshold',
  // Gas Estimation
  'gasBufferPercent',
  'gasPollIntervalMs',
  'gasPolPriceFallbackUsd',
  'polymarketSettlementGasUnits',
  // Execution
  'executionMinFillRatio',
  // Risk Management
  'riskMaxPositionPct',
  'riskMaxOpenPairs',
  'riskDailyLossPct',
  // Correlation Clusters
  'clusterLlmTimeoutMs',
  'riskClusterHardLimitPct',
  'riskClusterSoftLimitPct',
  'riskAggregateClusterLimitPct',
  // Telegram
  'telegramTestAlertCron',
  'telegramTestAlertTimezone',
  'telegramSendTimeoutMs',
  'telegramMaxRetries',
  'telegramBufferMaxSize',
  'telegramCircuitBreakMs',
  // CSV
  'csvEnabled',
  // LLM Scoring
  'llmPrimaryProvider',
  'llmPrimaryModel',
  'llmEscalationProvider',
  'llmEscalationModel',
  'llmEscalationMin',
  'llmEscalationMax',
  'llmAutoApproveThreshold',
  'llmMinReviewThreshold',
  'llmMaxTokens',
  'llmTimeoutMs',
  // Discovery
  'discoveryEnabled',
  'discoveryRunOnStartup',
  'discoveryCronExpression',
  'discoveryPrefilterThreshold',
  'discoverySettlementWindowDays',
  'discoveryMaxCandidatesPerContract',
  'discoveryLlmConcurrency',
  // Resolution Polling
  'resolutionPollerEnabled',
  'resolutionPollerCronExpression',
  'resolutionPollerBatchSize',
  // Calibration
  'calibrationEnabled',
  'calibrationCronExpression',
  // Staleness
  'orderbookStalenessThresholdMs',
  'wsStalenessThresholdMs',
  // Polling Concurrency
  'kalshiPollingConcurrency',
  'polymarketPollingConcurrency',
  // Audit Log
  'auditLogRetentionDays',
  // Stress Testing
  'stressTestScenarios',
  'stressTestDefaultDailyVol',
  'stressTestMinSnapshots',
  // Auto-Unwind
  'autoUnwindEnabled',
  'autoUnwindDelayMs',
  'autoUnwindMaxLossPct',
  // Adaptive Sequencing
  'adaptiveSequencingEnabled',
  'adaptiveSequencingLatencyThresholdMs',
  // Polymarket Order Polling
  'polymarketOrderPollTimeoutMs',
  'polymarketOrderPollIntervalMs',
  // Exit Mode
  'exitMode',
  'exitEdgeEvapMultiplier',
  'exitConfidenceDropPct',
  'exitTimeDecayHorizonH',
  'exitTimeDecaySteepness',
  'exitTimeDecayTrigger',
  'exitRiskBudgetPct',
  'exitRiskRankCutoff',
  'exitMinDepth',
  'exitDepthSlippageTolerance',
  'exitMaxChunkSize',
  'exitProfitCaptureRatio',
  // Pair Concentration Limits
  'pairCooldownMinutes',
  'pairMaxConcurrentPositions',
  'pairDiversityThreshold',
];

/** Env var keys that correspond to Category B fields */
const EXPECTED_ENV_KEY_MAPPING: Record<string, string> = {
  bankrollUsd: 'RISK_BANKROLL_USD',
  pollingIntervalMs: 'POLLING_INTERVAL_MS',
  detectionMinEdgeThreshold: 'DETECTION_MIN_EDGE_THRESHOLD',
  detectionGasEstimateUsd: 'DETECTION_GAS_ESTIMATE_USD',
  detectionPositionSizeUsd: 'DETECTION_POSITION_SIZE_USD',
  minAnnualizedReturn: 'MIN_ANNUALIZED_RETURN',
  depthEdgeScalingFactor: 'DEPTH_EDGE_SCALING_FACTOR',
  maxDynamicEdgeThreshold: 'MAX_DYNAMIC_EDGE_THRESHOLD',
  gasBufferPercent: 'GAS_BUFFER_PERCENT',
  gasPollIntervalMs: 'GAS_POLL_INTERVAL_MS',
  gasPolPriceFallbackUsd: 'GAS_POL_PRICE_FALLBACK_USD',
  polymarketSettlementGasUnits: 'POLYMARKET_SETTLEMENT_GAS_UNITS',
  executionMinFillRatio: 'EXECUTION_MIN_FILL_RATIO',
  riskMaxPositionPct: 'RISK_MAX_POSITION_PCT',
  riskMaxOpenPairs: 'RISK_MAX_OPEN_PAIRS',
  riskDailyLossPct: 'RISK_DAILY_LOSS_PCT',
  clusterLlmTimeoutMs: 'CLUSTER_LLM_TIMEOUT_MS',
  riskClusterHardLimitPct: 'RISK_CLUSTER_HARD_LIMIT_PCT',
  riskClusterSoftLimitPct: 'RISK_CLUSTER_SOFT_LIMIT_PCT',
  riskAggregateClusterLimitPct: 'RISK_AGGREGATE_CLUSTER_LIMIT_PCT',
  telegramTestAlertCron: 'TELEGRAM_TEST_ALERT_CRON',
  telegramTestAlertTimezone: 'TELEGRAM_TEST_ALERT_TIMEZONE',
  telegramSendTimeoutMs: 'TELEGRAM_SEND_TIMEOUT_MS',
  telegramMaxRetries: 'TELEGRAM_MAX_RETRIES',
  telegramBufferMaxSize: 'TELEGRAM_BUFFER_MAX_SIZE',
  telegramCircuitBreakMs: 'TELEGRAM_CIRCUIT_BREAK_MS',
  csvEnabled: 'CSV_ENABLED',
  llmPrimaryProvider: 'LLM_PRIMARY_PROVIDER',
  llmPrimaryModel: 'LLM_PRIMARY_MODEL',
  llmEscalationProvider: 'LLM_ESCALATION_PROVIDER',
  llmEscalationModel: 'LLM_ESCALATION_MODEL',
  llmEscalationMin: 'LLM_ESCALATION_MIN',
  llmEscalationMax: 'LLM_ESCALATION_MAX',
  llmAutoApproveThreshold: 'LLM_AUTO_APPROVE_THRESHOLD',
  llmMinReviewThreshold: 'LLM_MIN_REVIEW_THRESHOLD',
  llmMaxTokens: 'LLM_MAX_TOKENS',
  llmTimeoutMs: 'LLM_TIMEOUT_MS',
  discoveryEnabled: 'DISCOVERY_ENABLED',
  discoveryRunOnStartup: 'DISCOVERY_RUN_ON_STARTUP',
  discoveryCronExpression: 'DISCOVERY_CRON_EXPRESSION',
  discoveryPrefilterThreshold: 'DISCOVERY_PREFILTER_THRESHOLD',
  discoverySettlementWindowDays: 'DISCOVERY_SETTLEMENT_WINDOW_DAYS',
  discoveryMaxCandidatesPerContract: 'DISCOVERY_MAX_CANDIDATES_PER_CONTRACT',
  discoveryLlmConcurrency: 'DISCOVERY_LLM_CONCURRENCY',
  resolutionPollerEnabled: 'RESOLUTION_POLLER_ENABLED',
  resolutionPollerCronExpression: 'RESOLUTION_POLLER_CRON_EXPRESSION',
  resolutionPollerBatchSize: 'RESOLUTION_POLLER_BATCH_SIZE',
  calibrationEnabled: 'CALIBRATION_ENABLED',
  calibrationCronExpression: 'CALIBRATION_CRON_EXPRESSION',
  orderbookStalenessThresholdMs: 'ORDERBOOK_STALENESS_THRESHOLD_MS',
  wsStalenessThresholdMs: 'WS_STALENESS_THRESHOLD_MS',
  kalshiPollingConcurrency: 'KALSHI_POLLING_CONCURRENCY',
  polymarketPollingConcurrency: 'POLYMARKET_POLLING_CONCURRENCY',
  auditLogRetentionDays: 'AUDIT_LOG_RETENTION_DAYS',
  stressTestScenarios: 'STRESS_TEST_SCENARIOS',
  stressTestDefaultDailyVol: 'STRESS_TEST_DEFAULT_DAILY_VOL',
  stressTestMinSnapshots: 'STRESS_TEST_MIN_SNAPSHOTS',
  autoUnwindEnabled: 'AUTO_UNWIND_ENABLED',
  autoUnwindDelayMs: 'AUTO_UNWIND_DELAY_MS',
  autoUnwindMaxLossPct: 'AUTO_UNWIND_MAX_LOSS_PCT',
  adaptiveSequencingEnabled: 'ADAPTIVE_SEQUENCING_ENABLED',
  adaptiveSequencingLatencyThresholdMs:
    'ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS',
  polymarketOrderPollTimeoutMs: 'POLYMARKET_ORDER_POLL_TIMEOUT_MS',
  polymarketOrderPollIntervalMs: 'POLYMARKET_ORDER_POLL_INTERVAL_MS',
  exitMode: 'EXIT_MODE',
  exitEdgeEvapMultiplier: 'EXIT_EDGE_EVAP_MULTIPLIER',
  exitConfidenceDropPct: 'EXIT_CONFIDENCE_DROP_PCT',
  exitTimeDecayHorizonH: 'EXIT_TIME_DECAY_HORIZON_H',
  exitTimeDecaySteepness: 'EXIT_TIME_DECAY_STEEPNESS',
  exitTimeDecayTrigger: 'EXIT_TIME_DECAY_TRIGGER',
  exitRiskBudgetPct: 'EXIT_RISK_BUDGET_PCT',
  exitRiskRankCutoff: 'EXIT_RISK_RANK_CUTOFF',
  exitMinDepth: 'EXIT_MIN_DEPTH',
  exitDepthSlippageTolerance: 'EXIT_DEPTH_SLIPPAGE_TOLERANCE',
  exitMaxChunkSize: 'EXIT_MAX_CHUNK_SIZE',
  exitProfitCaptureRatio: 'EXIT_PROFIT_CAPTURE_RATIO',
  pairCooldownMinutes: 'PAIR_COOLDOWN_MINUTES',
  pairMaxConcurrentPositions: 'PAIR_MAX_CONCURRENT_POSITIONS',
  pairDiversityThreshold: 'PAIR_DIVERSITY_THRESHOLD',
};

describe('CONFIG_DEFAULTS', () => {
  it('[P0] should contain an entry for every Category B field (71 fields)', () => {
    for (const field of CATEGORY_B_FIELDS) {
      expect(CONFIG_DEFAULTS).toHaveProperty(field);
    }
    // Count: 71 Category B fields
    const categoryBKeys = CATEGORY_B_FIELDS.filter(
      (f) => f !== 'bankrollUsd' && f !== 'paperBankrollUsd',
    );
    expect(categoryBKeys.length).toBe(78);
  });

  it('[P0] should include bankrollUsd mapped to RISK_BANKROLL_USD', () => {
    expect(CONFIG_DEFAULTS).toHaveProperty('bankrollUsd');
    expect(CONFIG_DEFAULTS.bankrollUsd.envKey).toBe('RISK_BANKROLL_USD');
  });

  it('[P0] should have an envKey and defaultValue for every entry', () => {
    const entries = Object.entries(CONFIG_DEFAULTS);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of Object.values(CONFIG_DEFAULTS)) {
      expect(entry).toHaveProperty('envKey');
      expect(typeof entry.envKey).toBe('string');
      expect(entry.envKey.length).toBeGreaterThan(0);

      expect(entry).toHaveProperty('defaultValue');
      // defaultValue can be string, number, boolean, or null
      expect(
        ['string', 'number', 'boolean'].includes(typeof entry.defaultValue) ||
          entry.defaultValue === null,
      ).toBe(true);
    }
  });

  it('[P0] should map every entry envKey to a valid key in the Zod env schema', () => {
    const zodSchemaKeys = Object.keys(envSchema.shape);

    for (const [fieldName, entry] of Object.entries(CONFIG_DEFAULTS)) {
      expect(
        zodSchemaKeys,
        `CONFIG_DEFAULTS.${fieldName}.envKey="${entry.envKey}" not found in envSchema`,
      ).toContain(entry.envKey);
    }
  });

  it('[P1] should have correct envKey mappings for spot-checked fields', () => {
    for (const [fieldName, expectedEnvKey] of Object.entries(
      EXPECTED_ENV_KEY_MAPPING,
    )) {
      const entry = (CONFIG_DEFAULTS as Record<string, { envKey: string }>)[
        fieldName
      ];
      if (entry) {
        expect(
          entry.envKey,
          `Expected ${fieldName}.envKey to be ${expectedEnvKey}`,
        ).toBe(expectedEnvKey);
      }
    }
  });

  it('[P1] should have no duplicate envKey values across entries', () => {
    const envKeys = Object.values(CONFIG_DEFAULTS).map((entry) => entry.envKey);
    const uniqueKeys = new Set(envKeys);
    expect(envKeys.length).toBe(uniqueKeys.size);
  });

  it('[P1] should have correct default values for financial decimal fields', () => {
    expect(CONFIG_DEFAULTS.detectionMinEdgeThreshold.defaultValue).toBe(
      '0.008',
    );
    expect(CONFIG_DEFAULTS.detectionGasEstimateUsd.defaultValue).toBe('0.30');
    expect(CONFIG_DEFAULTS.detectionPositionSizeUsd.defaultValue).toBe('300');
    expect(CONFIG_DEFAULTS.minAnnualizedReturn.defaultValue).toBe('0.15');
    expect(CONFIG_DEFAULTS.gasPolPriceFallbackUsd.defaultValue).toBe('0.40');
    expect(CONFIG_DEFAULTS.executionMinFillRatio.defaultValue).toBe('0.25');
    expect(CONFIG_DEFAULTS.riskMaxPositionPct.defaultValue).toBe('0.03');
    expect(CONFIG_DEFAULTS.riskDailyLossPct.defaultValue).toBe('0.05');
    expect(CONFIG_DEFAULTS.bankrollUsd.defaultValue).toBe('10000');
  });

  it('[P1] should have correct default values for integer fields', () => {
    expect(CONFIG_DEFAULTS.pollingIntervalMs.defaultValue).toBe(30000);
    expect(CONFIG_DEFAULTS.riskMaxOpenPairs.defaultValue).toBe(10);
    expect(CONFIG_DEFAULTS.gasBufferPercent.defaultValue).toBe(20);
    expect(CONFIG_DEFAULTS.telegramSendTimeoutMs.defaultValue).toBe(2000);
    expect(CONFIG_DEFAULTS.llmAutoApproveThreshold.defaultValue).toBe(85);
    expect(CONFIG_DEFAULTS.auditLogRetentionDays.defaultValue).toBe(7);
    expect(CONFIG_DEFAULTS.stressTestScenarios.defaultValue).toBe(1000);
  });

  it('[P1] should have correct default values for boolean fields', () => {
    expect(CONFIG_DEFAULTS.csvEnabled.defaultValue).toBe(true);
    expect(CONFIG_DEFAULTS.discoveryEnabled.defaultValue).toBe(true);
    expect(CONFIG_DEFAULTS.discoveryRunOnStartup.defaultValue).toBe(false);
    expect(CONFIG_DEFAULTS.resolutionPollerEnabled.defaultValue).toBe(true);
    expect(CONFIG_DEFAULTS.calibrationEnabled.defaultValue).toBe(true);
    expect(CONFIG_DEFAULTS.autoUnwindEnabled.defaultValue).toBe(false);
    expect(CONFIG_DEFAULTS.adaptiveSequencingEnabled.defaultValue).toBe(true);
  });

  it('[P2] should have correct default values for string/enum fields', () => {
    expect(CONFIG_DEFAULTS.exitMode.defaultValue).toBe('fixed');
    expect(CONFIG_DEFAULTS.llmPrimaryProvider.defaultValue).toBe('gemini');
    expect(CONFIG_DEFAULTS.llmEscalationProvider.defaultValue).toBe(
      'anthropic',
    );
    expect(CONFIG_DEFAULTS.llmPrimaryModel.defaultValue).toBe(
      'gemini-2.5-flash',
    );
    expect(CONFIG_DEFAULTS.llmEscalationModel.defaultValue).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(CONFIG_DEFAULTS.telegramTestAlertCron.defaultValue).toBe(
      '0 8 * * *',
    );
    expect(CONFIG_DEFAULTS.telegramTestAlertTimezone.defaultValue).toBe('UTC');
    expect(CONFIG_DEFAULTS.discoveryCronExpression.defaultValue).toBe(
      '0 0 8,20 * * *',
    );
  });

  it('[P2] should have correct default values for float fields', () => {
    expect(CONFIG_DEFAULTS.exitEdgeEvapMultiplier.defaultValue).toBe(-1.0);
    expect(CONFIG_DEFAULTS.exitTimeDecaySteepness.defaultValue).toBe(2.0);
    expect(CONFIG_DEFAULTS.exitTimeDecayTrigger.defaultValue).toBe(0.8);
    expect(CONFIG_DEFAULTS.exitProfitCaptureRatio.defaultValue).toBe(0.5);
    expect(CONFIG_DEFAULTS.autoUnwindMaxLossPct.defaultValue).toBe(5);
  });

  it('[P1] should cover every EffectiveConfig field (except paperBankrollUsd) in CONFIG_DEFAULTS', () => {
    // Build the list of EffectiveConfig keys at runtime via a dummy object
    const effectiveConfigKeys: (keyof EffectiveConfig)[] = [
      'bankrollUsd',
      'pollingIntervalMs',
      'detectionMinEdgeThreshold',
      'detectionGasEstimateUsd',
      'detectionPositionSizeUsd',
      'minAnnualizedReturn',
      'gasBufferPercent',
      'gasPollIntervalMs',
      'gasPolPriceFallbackUsd',
      'polymarketSettlementGasUnits',
      'executionMinFillRatio',
      'riskMaxPositionPct',
      'riskMaxOpenPairs',
      'riskDailyLossPct',
      'clusterLlmTimeoutMs',
      'riskClusterHardLimitPct',
      'riskClusterSoftLimitPct',
      'riskAggregateClusterLimitPct',
      'telegramTestAlertCron',
      'telegramTestAlertTimezone',
      'telegramSendTimeoutMs',
      'telegramMaxRetries',
      'telegramBufferMaxSize',
      'telegramCircuitBreakMs',
      'csvEnabled',
      'llmPrimaryProvider',
      'llmPrimaryModel',
      'llmEscalationProvider',
      'llmEscalationModel',
      'llmEscalationMin',
      'llmEscalationMax',
      'llmAutoApproveThreshold',
      'llmMinReviewThreshold',
      'llmMaxTokens',
      'llmTimeoutMs',
      'discoveryEnabled',
      'discoveryRunOnStartup',
      'discoveryCronExpression',
      'discoveryPrefilterThreshold',
      'discoverySettlementWindowDays',
      'discoveryMaxCandidatesPerContract',
      'discoveryLlmConcurrency',
      'resolutionPollerEnabled',
      'resolutionPollerCronExpression',
      'resolutionPollerBatchSize',
      'calibrationEnabled',
      'calibrationCronExpression',
      'orderbookStalenessThresholdMs',
      'wsStalenessThresholdMs',
      'kalshiPollingConcurrency',
      'polymarketPollingConcurrency',
      'auditLogRetentionDays',
      'stressTestScenarios',
      'stressTestDefaultDailyVol',
      'stressTestMinSnapshots',
      'autoUnwindEnabled',
      'autoUnwindDelayMs',
      'autoUnwindMaxLossPct',
      'adaptiveSequencingEnabled',
      'adaptiveSequencingLatencyThresholdMs',
      'polymarketOrderPollTimeoutMs',
      'polymarketOrderPollIntervalMs',
      'exitMode',
      'exitEdgeEvapMultiplier',
      'exitConfidenceDropPct',
      'exitTimeDecayHorizonH',
      'exitTimeDecaySteepness',
      'exitTimeDecayTrigger',
      'exitRiskBudgetPct',
      'exitRiskRankCutoff',
      'exitMinDepth',
      'exitDepthSlippageTolerance',
      'exitMaxChunkSize',
      'exitProfitCaptureRatio',
      'pairCooldownMinutes',
      'pairMaxConcurrentPositions',
      'pairDiversityThreshold',
    ];
    for (const key of effectiveConfigKeys) {
      expect(
        CONFIG_DEFAULTS,
        `EffectiveConfig field "${key}" missing from CONFIG_DEFAULTS — resolve() in buildEffectiveConfig will silently return null`,
      ).toHaveProperty(key);
    }
  });

  it('[P2] should NOT include Category A env vars (secrets, infrastructure)', () => {
    const categoryAKeys = [
      'nodeEnv',
      'port',
      'databaseUrl',
      'kalshiApiKeyId',
      'kalshiPrivateKeyPath',
      'kalshiApiBaseUrl',
      'polymarketPrivateKey',
      'polymarketClobApiUrl',
      'polymarketWsUrl',
      'polymarketChainId',
      'polymarketRpcUrl',
      'polymarketGammaApiUrl',
      'operatorApiToken',
      'platformModeKalshi',
      'platformModePolymarket',
      'allowMixedMode',
      'telegramBotToken',
      'telegramChatId',
      'llmPrimaryApiKey',
      'llmEscalationApiKey',
      'csvTradeLogDir',
      'complianceMatrixConfigPath',
      'dashboardOrigin',
      'kalshiApiTier',
      'paperFillLatencyMsKalshi',
      'paperSlippageBpsKalshi',
      'paperFillLatencyMsPolymarket',
      'paperSlippageBpsPolymarket',
    ];
    for (const key of categoryAKeys) {
      expect(CONFIG_DEFAULTS).not.toHaveProperty(key);
    }
  });
});
