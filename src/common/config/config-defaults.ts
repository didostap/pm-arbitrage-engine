/**
 * Story 10-5.1 AC6 — CONFIG_DEFAULTS mapping.
 *
 * Single source of truth for the fallback chain:
 *   DB value → env var → Zod default.
 *
 * Maps each EngineConfig DB field name to:
 *   - envKey: the corresponding env var name in env.schema.ts
 *   - defaultValue: the Zod default value (typed as string | number | boolean | null)
 *
 * Used by:
 *   - getEffectiveConfig() for NULL-column fallback
 *   - Story 10-5-2 "reset to default" functionality
 *   - Seed script for populating fresh installs
 */

export interface ConfigDefaultEntry {
  envKey: string;
  defaultValue: string | number | boolean | null;
}

export const CONFIG_DEFAULTS = {
  // --- Bankroll ---
  bankrollUsd: { envKey: 'RISK_BANKROLL_USD', defaultValue: '10000' },

  // --- Trading Engine ---
  pollingIntervalMs: { envKey: 'POLLING_INTERVAL_MS', defaultValue: 30000 },
  tradingWindowStartUtc: {
    envKey: 'TRADING_WINDOW_START_UTC',
    defaultValue: 0,
  },
  tradingWindowEndUtc: { envKey: 'TRADING_WINDOW_END_UTC', defaultValue: 24 },

  // --- Edge Detection ---
  detectionMinEdgeThreshold: {
    envKey: 'DETECTION_MIN_EDGE_THRESHOLD',
    defaultValue: '0.008',
  },
  detectionGasEstimateUsd: {
    envKey: 'DETECTION_GAS_ESTIMATE_USD',
    defaultValue: '0.30',
  },
  detectionPositionSizeUsd: {
    envKey: 'DETECTION_POSITION_SIZE_USD',
    defaultValue: '300',
  },
  minAnnualizedReturn: {
    envKey: 'MIN_ANNUALIZED_RETURN',
    defaultValue: '0.15',
  },

  // --- Gas Estimation ---
  gasBufferPercent: { envKey: 'GAS_BUFFER_PERCENT', defaultValue: 20 },
  gasPollIntervalMs: { envKey: 'GAS_POLL_INTERVAL_MS', defaultValue: 30000 },
  gasPolPriceFallbackUsd: {
    envKey: 'GAS_POL_PRICE_FALLBACK_USD',
    defaultValue: '0.40',
  },
  polymarketSettlementGasUnits: {
    envKey: 'POLYMARKET_SETTLEMENT_GAS_UNITS',
    defaultValue: 150000,
  },

  // --- Detection Depth ---
  detectionMinFillRatio: {
    envKey: 'DETECTION_MIN_FILL_RATIO',
    defaultValue: '0.25',
  },
  depthEdgeScalingFactor: {
    envKey: 'DEPTH_EDGE_SCALING_FACTOR',
    defaultValue: '10',
  },
  maxDynamicEdgeThreshold: {
    envKey: 'MAX_DYNAMIC_EDGE_THRESHOLD',
    defaultValue: '0.05',
  },

  // --- Execution ---
  executionMinFillRatio: {
    envKey: 'EXECUTION_MIN_FILL_RATIO',
    defaultValue: '0.25',
  },
  dualLegMinDepthRatio: {
    envKey: 'DUAL_LEG_MIN_DEPTH_RATIO',
    defaultValue: '1.0',
  },

  // --- Risk Management ---
  riskMaxPositionPct: { envKey: 'RISK_MAX_POSITION_PCT', defaultValue: '0.03' },
  riskMaxOpenPairs: { envKey: 'RISK_MAX_OPEN_PAIRS', defaultValue: 10 },
  riskDailyLossPct: { envKey: 'RISK_DAILY_LOSS_PCT', defaultValue: '0.05' },

  // --- Correlation Clusters ---
  clusterLlmTimeoutMs: {
    envKey: 'CLUSTER_LLM_TIMEOUT_MS',
    defaultValue: 15000,
  },
  riskClusterHardLimitPct: {
    envKey: 'RISK_CLUSTER_HARD_LIMIT_PCT',
    defaultValue: '0.15',
  },
  riskClusterSoftLimitPct: {
    envKey: 'RISK_CLUSTER_SOFT_LIMIT_PCT',
    defaultValue: '0.12',
  },
  riskAggregateClusterLimitPct: {
    envKey: 'RISK_AGGREGATE_CLUSTER_LIMIT_PCT',
    defaultValue: '0.50',
  },

  // --- Telegram ---
  telegramTestAlertCron: {
    envKey: 'TELEGRAM_TEST_ALERT_CRON',
    defaultValue: '0 8 * * *',
  },
  telegramTestAlertTimezone: {
    envKey: 'TELEGRAM_TEST_ALERT_TIMEZONE',
    defaultValue: 'UTC',
  },
  telegramSendTimeoutMs: {
    envKey: 'TELEGRAM_SEND_TIMEOUT_MS',
    defaultValue: 2000,
  },
  telegramMaxRetries: { envKey: 'TELEGRAM_MAX_RETRIES', defaultValue: 3 },
  telegramBufferMaxSize: {
    envKey: 'TELEGRAM_BUFFER_MAX_SIZE',
    defaultValue: 100,
  },
  telegramCircuitBreakMs: {
    envKey: 'TELEGRAM_CIRCUIT_BREAK_MS',
    defaultValue: 60000,
  },

  // --- CSV ---
  csvEnabled: { envKey: 'CSV_ENABLED', defaultValue: true },

  // --- LLM Scoring ---
  llmPrimaryProvider: {
    envKey: 'LLM_PRIMARY_PROVIDER',
    defaultValue: 'gemini',
  },
  llmPrimaryModel: {
    envKey: 'LLM_PRIMARY_MODEL',
    defaultValue: 'gemini-2.5-flash',
  },
  llmEscalationProvider: {
    envKey: 'LLM_ESCALATION_PROVIDER',
    defaultValue: 'anthropic',
  },
  llmEscalationModel: {
    envKey: 'LLM_ESCALATION_MODEL',
    defaultValue: 'claude-haiku-4-5-20251001',
  },
  llmEscalationMin: { envKey: 'LLM_ESCALATION_MIN', defaultValue: 60 },
  llmEscalationMax: { envKey: 'LLM_ESCALATION_MAX', defaultValue: 84 },
  llmAutoApproveThreshold: {
    envKey: 'LLM_AUTO_APPROVE_THRESHOLD',
    defaultValue: 85,
  },
  llmMinReviewThreshold: {
    envKey: 'LLM_MIN_REVIEW_THRESHOLD',
    defaultValue: 40,
  },
  llmMaxTokens: { envKey: 'LLM_MAX_TOKENS', defaultValue: 1024 },
  llmTimeoutMs: { envKey: 'LLM_TIMEOUT_MS', defaultValue: 30000 },

  // --- Discovery ---
  discoveryEnabled: { envKey: 'DISCOVERY_ENABLED', defaultValue: true },
  discoveryRunOnStartup: {
    envKey: 'DISCOVERY_RUN_ON_STARTUP',
    defaultValue: false,
  },
  discoveryCronExpression: {
    envKey: 'DISCOVERY_CRON_EXPRESSION',
    defaultValue: '0 0 8,20 * * *',
  },
  discoveryPrefilterThreshold: {
    envKey: 'DISCOVERY_PREFILTER_THRESHOLD',
    defaultValue: '0.25',
  },
  discoverySettlementWindowDays: {
    envKey: 'DISCOVERY_SETTLEMENT_WINDOW_DAYS',
    defaultValue: 7,
  },
  discoveryMaxCandidatesPerContract: {
    envKey: 'DISCOVERY_MAX_CANDIDATES_PER_CONTRACT',
    defaultValue: 20,
  },
  discoveryLlmConcurrency: {
    envKey: 'DISCOVERY_LLM_CONCURRENCY',
    defaultValue: 10,
  },

  // --- Resolution Polling ---
  resolutionPollerEnabled: {
    envKey: 'RESOLUTION_POLLER_ENABLED',
    defaultValue: true,
  },
  resolutionPollerCronExpression: {
    envKey: 'RESOLUTION_POLLER_CRON_EXPRESSION',
    defaultValue: '0 0 6 * * *',
  },
  resolutionPollerBatchSize: {
    envKey: 'RESOLUTION_POLLER_BATCH_SIZE',
    defaultValue: 100,
  },

  // --- Calibration ---
  calibrationEnabled: { envKey: 'CALIBRATION_ENABLED', defaultValue: true },
  calibrationCronExpression: {
    envKey: 'CALIBRATION_CRON_EXPRESSION',
    defaultValue: '0 0 7 1 */3 *',
  },

  // --- Staleness Thresholds ---
  orderbookStalenessThresholdMs: {
    envKey: 'ORDERBOOK_STALENESS_THRESHOLD_MS',
    defaultValue: 90000,
  },
  wsStalenessThresholdMs: {
    envKey: 'WS_STALENESS_THRESHOLD_MS',
    defaultValue: 60000,
  },

  // --- Polling Concurrency ---
  kalshiPollingConcurrency: {
    envKey: 'KALSHI_POLLING_CONCURRENCY',
    defaultValue: 10,
  },
  polymarketPollingConcurrency: {
    envKey: 'POLYMARKET_POLLING_CONCURRENCY',
    defaultValue: 5,
  },

  // --- Audit Log ---
  auditLogRetentionDays: {
    envKey: 'AUDIT_LOG_RETENTION_DAYS',
    defaultValue: 7,
  },

  // --- Stress Testing ---
  stressTestScenarios: { envKey: 'STRESS_TEST_SCENARIOS', defaultValue: 1000 },
  stressTestDefaultDailyVol: {
    envKey: 'STRESS_TEST_DEFAULT_DAILY_VOL',
    defaultValue: '0.03',
  },
  stressTestMinSnapshots: {
    envKey: 'STRESS_TEST_MIN_SNAPSHOTS',
    defaultValue: 30,
  },

  // --- Auto-Unwind ---
  autoUnwindEnabled: { envKey: 'AUTO_UNWIND_ENABLED', defaultValue: false },
  autoUnwindDelayMs: { envKey: 'AUTO_UNWIND_DELAY_MS', defaultValue: 2000 },
  autoUnwindMaxLossPct: { envKey: 'AUTO_UNWIND_MAX_LOSS_PCT', defaultValue: 5 },

  // --- Adaptive Sequencing ---
  adaptiveSequencingEnabled: {
    envKey: 'ADAPTIVE_SEQUENCING_ENABLED',
    defaultValue: true,
  },
  adaptiveSequencingLatencyThresholdMs: {
    envKey: 'ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS',
    defaultValue: 200,
  },

  // --- Polymarket Order Polling ---
  polymarketOrderPollTimeoutMs: {
    envKey: 'POLYMARKET_ORDER_POLL_TIMEOUT_MS',
    defaultValue: 5000,
  },
  polymarketOrderPollIntervalMs: {
    envKey: 'POLYMARKET_ORDER_POLL_INTERVAL_MS',
    defaultValue: 500,
  },

  // --- Exit Mode ---
  exitMode: { envKey: 'EXIT_MODE', defaultValue: 'fixed' },
  exitEdgeEvapMultiplier: {
    envKey: 'EXIT_EDGE_EVAP_MULTIPLIER',
    defaultValue: -1.0,
  },
  exitConfidenceDropPct: {
    envKey: 'EXIT_CONFIDENCE_DROP_PCT',
    defaultValue: 20,
  },
  exitTimeDecayHorizonH: {
    envKey: 'EXIT_TIME_DECAY_HORIZON_H',
    defaultValue: 168,
  },
  exitTimeDecaySteepness: {
    envKey: 'EXIT_TIME_DECAY_STEEPNESS',
    defaultValue: 2.0,
  },
  exitTimeDecayTrigger: {
    envKey: 'EXIT_TIME_DECAY_TRIGGER',
    defaultValue: 0.8,
  },
  exitRiskBudgetPct: { envKey: 'EXIT_RISK_BUDGET_PCT', defaultValue: 85 },
  exitRiskRankCutoff: { envKey: 'EXIT_RISK_RANK_CUTOFF', defaultValue: 1 },
  exitMinDepth: { envKey: 'EXIT_MIN_DEPTH', defaultValue: 5 },
  exitDepthSlippageTolerance: {
    envKey: 'EXIT_DEPTH_SLIPPAGE_TOLERANCE',
    defaultValue: 0.02,
  },
  exitMaxChunkSize: { envKey: 'EXIT_MAX_CHUNK_SIZE', defaultValue: 0 },
  exitProfitCaptureRatio: {
    envKey: 'EXIT_PROFIT_CAPTURE_RATIO',
    defaultValue: 0.5,
  },

  // --- Pair Concentration Limits ---
  pairCooldownMinutes: {
    envKey: 'PAIR_COOLDOWN_MINUTES',
    defaultValue: 30,
  },
  pairMaxConcurrentPositions: {
    envKey: 'PAIR_MAX_CONCURRENT_POSITIONS',
    defaultValue: 2,
  },
  pairDiversityThreshold: {
    envKey: 'PAIR_DIVERSITY_THRESHOLD',
    defaultValue: 5,
  },
} satisfies Record<string, ConfigDefaultEntry>;
