/**
 * Story 10-5.1 AC4 — EffectiveConfig interface + EngineConfigUpdateInput type.
 *
 * EffectiveConfig: fully-resolved config where every field has a concrete value
 * (DB value → env var fallback → Zod default). No field is optional.
 *
 * Financial Decimal fields are typed as `string` for safe transport —
 * consuming services convert to `Decimal` as needed.
 */

/** Fully-resolved engine configuration. All fields guaranteed non-optional. */
export interface EffectiveConfig {
  // --- Bankroll ---
  bankrollUsd: string;
  paperBankrollUsd: string | null;

  // --- Trading Engine ---
  pollingIntervalMs: number;

  // --- Edge Detection ---
  detectionMinEdgeThreshold: string;
  detectionGasEstimateUsd: string;
  detectionPositionSizeUsd: string;
  minAnnualizedReturn: string;

  detectionMinFillRatio: string;

  // --- Gas Estimation ---
  gasBufferPercent: number;
  gasPollIntervalMs: number;
  gasPolPriceFallbackUsd: string;
  polymarketSettlementGasUnits: number;

  // --- Execution ---
  executionMinFillRatio: string;
  dualLegMinDepthRatio: string;

  // --- Risk Management ---
  riskMaxPositionPct: string;
  riskMaxOpenPairs: number;
  riskDailyLossPct: string;

  // --- Correlation Clusters ---
  clusterLlmTimeoutMs: number;
  riskClusterHardLimitPct: string;
  riskClusterSoftLimitPct: string;
  riskAggregateClusterLimitPct: string;

  // --- Telegram ---
  telegramTestAlertCron: string;
  telegramTestAlertTimezone: string;
  telegramSendTimeoutMs: number;
  telegramMaxRetries: number;
  telegramBufferMaxSize: number;
  telegramCircuitBreakMs: number;

  // --- CSV ---
  csvEnabled: boolean;

  // --- LLM Scoring ---
  llmPrimaryProvider: string;
  llmPrimaryModel: string;
  llmEscalationProvider: string;
  llmEscalationModel: string;
  llmEscalationMin: number;
  llmEscalationMax: number;
  llmAutoApproveThreshold: number;
  llmMinReviewThreshold: number;
  llmMaxTokens: number;
  llmTimeoutMs: number;

  // --- Discovery ---
  discoveryEnabled: boolean;
  discoveryRunOnStartup: boolean;
  discoveryCronExpression: string;
  discoveryPrefilterThreshold: string;
  discoverySettlementWindowDays: number;
  discoveryMaxCandidatesPerContract: number;
  discoveryLlmConcurrency: number;

  // --- Resolution Polling ---
  resolutionPollerEnabled: boolean;
  resolutionPollerCronExpression: string;
  resolutionPollerBatchSize: number;

  // --- Calibration ---
  calibrationEnabled: boolean;
  calibrationCronExpression: string;

  // --- Staleness Thresholds ---
  orderbookStalenessThresholdMs: number;
  wsStalenessThresholdMs: number;

  // --- Polling Concurrency ---
  kalshiPollingConcurrency: number;
  polymarketPollingConcurrency: number;

  // --- Audit Log ---
  auditLogRetentionDays: number;

  // --- Stress Testing ---
  stressTestScenarios: number;
  stressTestDefaultDailyVol: string;
  stressTestMinSnapshots: number;

  // --- Auto-Unwind ---
  autoUnwindEnabled: boolean;
  autoUnwindDelayMs: number;
  autoUnwindMaxLossPct: number;

  // --- Adaptive Sequencing ---
  adaptiveSequencingEnabled: boolean;
  adaptiveSequencingLatencyThresholdMs: number;

  // --- Polymarket Order Polling ---
  polymarketOrderPollTimeoutMs: number;
  polymarketOrderPollIntervalMs: number;

  // --- Exit Mode ---
  exitMode: string;
  exitEdgeEvapMultiplier: number;
  exitConfidenceDropPct: number;
  exitTimeDecayHorizonH: number;
  exitTimeDecaySteepness: number;
  exitTimeDecayTrigger: number;
  exitRiskBudgetPct: number;
  exitRiskRankCutoff: number;
  exitMinDepth: number;
  exitProfitCaptureRatio: number;
}

/**
 * Input type for bulk-updating EngineConfig.
 * All Category B fields, all optional (partial updates).
 * Excludes: id, singletonKey, timestamps.
 */
export type EngineConfigUpdateInput = Partial<
  Omit<EffectiveConfig, 'paperBankrollUsd'>
>;
