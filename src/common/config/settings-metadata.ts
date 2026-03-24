/**
 * Story 10-5.2 AC4 — SETTINGS_METADATA registry.
 *
 * Single source of truth for dashboard Settings UI rendering + PATCH validation.
 * Maps every CONFIG_DEFAULTS key to display metadata (group, label, description,
 * type, envDefault, optional constraints).
 *
 * Complements CONFIG_DEFAULTS (which provides envKey + defaultValue).
 */

import { CONFIG_DEFAULTS } from './config-defaults.js';

// ---------------------------------------------------------------------------
// SettingsGroup — 15 logical UI sections (approved ordering from Story 10-5-3)
// ---------------------------------------------------------------------------

export enum SettingsGroup {
  ExitStrategy = 'Exit Strategy',
  RiskManagement = 'Risk Management',
  Execution = 'Execution',
  AutoUnwind = 'Auto-Unwind',
  DetectionEdge = 'Detection & Edge',
  Discovery = 'Discovery',
  LlmScoring = 'LLM Scoring',
  ResolutionCalibration = 'Resolution & Calibration',
  DataQualityStaleness = 'Data Quality & Staleness',
  PaperTrading = 'Paper Trading',
  TradingEngine = 'Trading Engine',
  GasEstimation = 'Gas Estimation',
  Telegram = 'Telegram',
  LoggingCompliance = 'Logging & Compliance',
  StressTesting = 'Stress Testing',
}

// ---------------------------------------------------------------------------
// Metadata entry shape
// ---------------------------------------------------------------------------

export type SettingsDataType =
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'string'
  | 'enum';

export interface SettingsMetadataEntry {
  group: SettingsGroup;
  label: string;
  description: string;
  type: SettingsDataType;
  envDefault: string | number | boolean | null;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
}

// ---------------------------------------------------------------------------
// SETTINGS_METADATA — all 73 CONFIG_DEFAULTS keys (72 Category B + bankrollUsd reference; bankrollUsd excluded from settings UI)
// ---------------------------------------------------------------------------

export const SETTINGS_METADATA: Record<
  keyof typeof CONFIG_DEFAULTS,
  SettingsMetadataEntry
> = {
  // ── Bankroll (Risk Management group) ──────────────────────────────────
  bankrollUsd: {
    group: SettingsGroup.RiskManagement,
    label: 'Bankroll (USD)',
    description:
      'Total trading bankroll in USD. Position sizes derived from this.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.bankrollUsd.defaultValue,
    unit: 'USD',
  },

  // ── Trading Engine ────────────────────────────────────────────────────
  pollingIntervalMs: {
    group: SettingsGroup.TradingEngine,
    label: 'Polling Interval',
    description: 'Main trading loop polling interval.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.pollingIntervalMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },

  // ── Detection & Edge ──────────────────────────────────────────────────
  detectionMinEdgeThreshold: {
    group: SettingsGroup.DetectionEdge,
    label: 'Min Edge Threshold',
    description:
      'Minimum net edge (decimal probability) to qualify as an opportunity.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.detectionMinEdgeThreshold.defaultValue,
  },
  detectionGasEstimateUsd: {
    group: SettingsGroup.DetectionEdge,
    label: 'Gas Estimate (USD)',
    description:
      'Estimated gas cost per Polymarket transaction for edge calculation.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.detectionGasEstimateUsd.defaultValue,
    unit: 'USD',
  },
  detectionPositionSizeUsd: {
    group: SettingsGroup.DetectionEdge,
    label: 'Position Size (USD)',
    description: 'Default position size used in edge calculation.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.detectionPositionSizeUsd.defaultValue,
    unit: 'USD',
  },
  minAnnualizedReturn: {
    group: SettingsGroup.DetectionEdge,
    label: 'Min Annualized Return',
    description: 'Minimum annualized return threshold to filter opportunities.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.minAnnualizedReturn.defaultValue,
  },

  detectionMinFillRatio: {
    group: SettingsGroup.DetectionEdge,
    label: 'Min VWAP Fill Ratio',
    description:
      'Minimum ratio of fillable depth to target contracts for VWAP edge calculation. Opportunities below this are filtered as insufficient depth.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.detectionMinFillRatio.defaultValue,
  },

  // ── Gas Estimation ────────────────────────────────────────────────────
  gasBufferPercent: {
    group: SettingsGroup.GasEstimation,
    label: 'Gas Buffer',
    description: 'Safety buffer added to gas estimates.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.gasBufferPercent.defaultValue,
    min: 0,
    max: 100,
    unit: '%',
  },
  gasPollIntervalMs: {
    group: SettingsGroup.GasEstimation,
    label: 'Gas Poll Interval',
    description: 'How often to refresh gas price estimates.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.gasPollIntervalMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },
  gasPolPriceFallbackUsd: {
    group: SettingsGroup.GasEstimation,
    label: 'POL Price Fallback (USD)',
    description: 'Fallback POL/USD price when oracle is unavailable.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.gasPolPriceFallbackUsd.defaultValue,
    unit: 'USD',
  },
  polymarketSettlementGasUnits: {
    group: SettingsGroup.GasEstimation,
    label: 'Settlement Gas Units',
    description: 'Gas units for Polymarket settlement transactions.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.polymarketSettlementGasUnits.defaultValue,
    min: 1,
    unit: 'gas',
  },

  // ── Execution ─────────────────────────────────────────────────────────
  executionMinFillRatio: {
    group: SettingsGroup.Execution,
    label: 'Min Fill Ratio',
    description: 'Minimum acceptable fill ratio for order execution.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.executionMinFillRatio.defaultValue,
  },
  dualLegMinDepthRatio: {
    group: SettingsGroup.Execution,
    label: 'Dual-Leg Min Depth Ratio',
    description:
      'Minimum ratio of order book depth to target position size required on both platforms before entry. 1.0 = full target must fit.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.dualLegMinDepthRatio.defaultValue,
  },
  adaptiveSequencingEnabled: {
    group: SettingsGroup.Execution,
    label: 'Adaptive Sequencing',
    description: 'Enable adaptive leg sequencing based on P95 latency.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.adaptiveSequencingEnabled.defaultValue,
  },
  adaptiveSequencingLatencyThresholdMs: {
    group: SettingsGroup.Execution,
    label: 'Latency Threshold',
    description: 'P95 latency threshold for adaptive sequencing decisions.',
    type: 'integer',
    envDefault:
      CONFIG_DEFAULTS.adaptiveSequencingLatencyThresholdMs.defaultValue,
    min: 1,
    unit: 'ms',
  },
  polymarketOrderPollTimeoutMs: {
    group: SettingsGroup.Execution,
    label: 'Order Poll Timeout',
    description: 'Timeout for Polymarket order fill polling.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.polymarketOrderPollTimeoutMs.defaultValue,
    min: 1000,
    max: 30000,
    unit: 'ms',
  },
  polymarketOrderPollIntervalMs: {
    group: SettingsGroup.Execution,
    label: 'Order Poll Interval',
    description: 'Interval between Polymarket order fill polls.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.polymarketOrderPollIntervalMs.defaultValue,
    min: 100,
    max: 5000,
    unit: 'ms',
  },

  // ── Risk Management ───────────────────────────────────────────────────
  riskMaxPositionPct: {
    group: SettingsGroup.RiskManagement,
    label: 'Max Position Size',
    description: 'Maximum position size as fraction of bankroll (0-1).',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.riskMaxPositionPct.defaultValue,
  },
  riskMaxOpenPairs: {
    group: SettingsGroup.RiskManagement,
    label: 'Max Open Pairs',
    description: 'Maximum number of simultaneously open arbitrage pairs.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.riskMaxOpenPairs.defaultValue,
    min: 1,
  },
  riskDailyLossPct: {
    group: SettingsGroup.RiskManagement,
    label: 'Daily Loss Limit',
    description:
      'Maximum daily loss as fraction of bankroll (0-1). Triggers trading halt.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.riskDailyLossPct.defaultValue,
  },
  clusterLlmTimeoutMs: {
    group: SettingsGroup.RiskManagement,
    label: 'Cluster LLM Timeout',
    description: 'Timeout for LLM cluster assignment requests.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.clusterLlmTimeoutMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },
  riskClusterHardLimitPct: {
    group: SettingsGroup.RiskManagement,
    label: 'Cluster Hard Limit',
    description:
      'Maximum exposure per correlation cluster (0-1). Rejects new positions.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.riskClusterHardLimitPct.defaultValue,
  },
  riskClusterSoftLimitPct: {
    group: SettingsGroup.RiskManagement,
    label: 'Cluster Soft Limit',
    description:
      'Soft exposure limit per cluster (0-1). Triggers approach alert.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.riskClusterSoftLimitPct.defaultValue,
  },
  riskAggregateClusterLimitPct: {
    group: SettingsGroup.RiskManagement,
    label: 'Aggregate Cluster Limit',
    description: 'Maximum aggregate exposure across all clusters (0-1).',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.riskAggregateClusterLimitPct.defaultValue,
  },
  auditLogRetentionDays: {
    group: SettingsGroup.LoggingCompliance,
    label: 'Audit Log Retention',
    description: 'Days to retain audit log entries before pruning.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.auditLogRetentionDays.defaultValue,
    min: 0,
    max: 3650,
    unit: 'days',
  },

  // ── Telegram ──────────────────────────────────────────────────────────
  telegramTestAlertCron: {
    group: SettingsGroup.Telegram,
    label: 'Test Alert Cron',
    description: 'Cron expression for daily Telegram test alert.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.telegramTestAlertCron.defaultValue,
  },
  telegramTestAlertTimezone: {
    group: SettingsGroup.Telegram,
    label: 'Test Alert Timezone',
    description: 'Timezone for Telegram test alert cron schedule.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.telegramTestAlertTimezone.defaultValue,
  },
  telegramSendTimeoutMs: {
    group: SettingsGroup.Telegram,
    label: 'Send Timeout',
    description: 'Timeout for individual Telegram API send requests.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.telegramSendTimeoutMs.defaultValue,
    min: 500,
    unit: 'ms',
  },
  telegramMaxRetries: {
    group: SettingsGroup.Telegram,
    label: 'Max Retries',
    description: 'Maximum retry attempts for failed Telegram sends.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.telegramMaxRetries.defaultValue,
    min: 0,
    max: 10,
  },
  telegramBufferMaxSize: {
    group: SettingsGroup.Telegram,
    label: 'Buffer Max Size',
    description: 'Maximum queued Telegram messages before oldest are dropped.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.telegramBufferMaxSize.defaultValue,
    min: 1,
  },
  telegramCircuitBreakMs: {
    group: SettingsGroup.Telegram,
    label: 'Circuit Break Duration',
    description: 'Duration to pause sends after consecutive failures.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.telegramCircuitBreakMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },

  // ── CSV / Logging & Compliance ────────────────────────────────────────
  csvEnabled: {
    group: SettingsGroup.LoggingCompliance,
    label: 'CSV Trade Logging',
    description: 'Enable daily CSV trade log files.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.csvEnabled.defaultValue,
  },

  // ── LLM Scoring ──────────────────────────────────────────────────────
  llmPrimaryProvider: {
    group: SettingsGroup.LlmScoring,
    label: 'Primary LLM Provider',
    description: 'LLM provider for primary confidence scoring.',
    type: 'enum',
    envDefault: CONFIG_DEFAULTS.llmPrimaryProvider.defaultValue,
    options: ['gemini', 'anthropic'],
  },
  llmPrimaryModel: {
    group: SettingsGroup.LlmScoring,
    label: 'Primary LLM Model',
    description: 'Model name for primary confidence scoring.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.llmPrimaryModel.defaultValue,
  },
  llmEscalationProvider: {
    group: SettingsGroup.LlmScoring,
    label: 'Escalation LLM Provider',
    description: 'LLM provider for escalation scoring (mid-confidence range).',
    type: 'enum',
    envDefault: CONFIG_DEFAULTS.llmEscalationProvider.defaultValue,
    options: ['gemini', 'anthropic'],
  },
  llmEscalationModel: {
    group: SettingsGroup.LlmScoring,
    label: 'Escalation LLM Model',
    description: 'Model name for escalation confidence scoring.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.llmEscalationModel.defaultValue,
  },
  llmEscalationMin: {
    group: SettingsGroup.LlmScoring,
    label: 'Escalation Min Score',
    description: 'Minimum primary score to trigger escalation scoring.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmEscalationMin.defaultValue,
    min: 0,
    max: 100,
  },
  llmEscalationMax: {
    group: SettingsGroup.LlmScoring,
    label: 'Escalation Max Score',
    description: 'Maximum primary score that still triggers escalation.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmEscalationMax.defaultValue,
    min: 0,
    max: 100,
  },
  llmAutoApproveThreshold: {
    group: SettingsGroup.LlmScoring,
    label: 'Auto-Approve Threshold',
    description: 'Confidence score above which matches are auto-approved.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmAutoApproveThreshold.defaultValue,
    min: 0,
    max: 100,
  },
  llmMinReviewThreshold: {
    group: SettingsGroup.LlmScoring,
    label: 'Min Review Threshold',
    description:
      'Minimum confidence score to keep a match for review (below = rejected).',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmMinReviewThreshold.defaultValue,
    min: 0,
    max: 100,
  },
  llmMaxTokens: {
    group: SettingsGroup.LlmScoring,
    label: 'Max Tokens',
    description: 'Maximum tokens per LLM scoring request.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmMaxTokens.defaultValue,
    min: 1,
  },
  llmTimeoutMs: {
    group: SettingsGroup.LlmScoring,
    label: 'LLM Timeout',
    description: 'Timeout for LLM API requests.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.llmTimeoutMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },

  // ── Discovery ─────────────────────────────────────────────────────────
  discoveryEnabled: {
    group: SettingsGroup.Discovery,
    label: 'Discovery Enabled',
    description: 'Enable automated candidate discovery pipeline.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.discoveryEnabled.defaultValue,
  },
  discoveryRunOnStartup: {
    group: SettingsGroup.Discovery,
    label: 'Run on Startup',
    description: 'Run discovery pipeline immediately on engine start.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.discoveryRunOnStartup.defaultValue,
  },
  discoveryCronExpression: {
    group: SettingsGroup.Discovery,
    label: 'Discovery Cron',
    description: 'Cron schedule for candidate discovery runs.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.discoveryCronExpression.defaultValue,
  },
  discoveryPrefilterThreshold: {
    group: SettingsGroup.Discovery,
    label: 'Prefilter Threshold',
    description: 'Fuzzy match threshold for candidate prefiltering (0-1).',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.discoveryPrefilterThreshold.defaultValue,
  },
  discoverySettlementWindowDays: {
    group: SettingsGroup.Discovery,
    label: 'Settlement Window',
    description: 'Only discover contracts settling within this window.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.discoverySettlementWindowDays.defaultValue,
    min: 1,
    unit: 'days',
  },
  discoveryMaxCandidatesPerContract: {
    group: SettingsGroup.Discovery,
    label: 'Max Candidates Per Contract',
    description: 'Maximum candidate matches per source contract.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.discoveryMaxCandidatesPerContract.defaultValue,
    min: 1,
  },
  discoveryLlmConcurrency: {
    group: SettingsGroup.Discovery,
    label: 'LLM Concurrency',
    description: 'Concurrent LLM scoring requests during discovery.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.discoveryLlmConcurrency.defaultValue,
    min: 1,
  },

  // ── Resolution & Calibration ──────────────────────────────────────────
  resolutionPollerEnabled: {
    group: SettingsGroup.ResolutionCalibration,
    label: 'Resolution Poller Enabled',
    description: 'Enable automated resolution outcome polling.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.resolutionPollerEnabled.defaultValue,
  },
  resolutionPollerCronExpression: {
    group: SettingsGroup.ResolutionCalibration,
    label: 'Resolution Poller Cron',
    description: 'Cron schedule for resolution outcome polling.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.resolutionPollerCronExpression.defaultValue,
  },
  resolutionPollerBatchSize: {
    group: SettingsGroup.ResolutionCalibration,
    label: 'Resolution Batch Size',
    description: 'Matches to check per resolution polling run.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.resolutionPollerBatchSize.defaultValue,
    min: 1,
  },
  calibrationEnabled: {
    group: SettingsGroup.ResolutionCalibration,
    label: 'Calibration Enabled',
    description: 'Enable periodic confidence score calibration.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.calibrationEnabled.defaultValue,
  },
  calibrationCronExpression: {
    group: SettingsGroup.ResolutionCalibration,
    label: 'Calibration Cron',
    description: 'Cron schedule for calibration analysis runs.',
    type: 'string',
    envDefault: CONFIG_DEFAULTS.calibrationCronExpression.defaultValue,
  },

  // ── Data Quality & Staleness ──────────────────────────────────────────
  orderbookStalenessThresholdMs: {
    group: SettingsGroup.DataQualityStaleness,
    label: 'Orderbook Staleness Threshold',
    description: 'Time before orderbook data is considered stale.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.orderbookStalenessThresholdMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },
  wsStalenessThresholdMs: {
    group: SettingsGroup.DataQualityStaleness,
    label: 'WebSocket Staleness Threshold',
    description: 'Time before WebSocket data is considered stale.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.wsStalenessThresholdMs.defaultValue,
    min: 1000,
    unit: 'ms',
  },
  kalshiPollingConcurrency: {
    group: SettingsGroup.DataQualityStaleness,
    label: 'Kalshi Polling Concurrency',
    description: 'Max concurrent Kalshi API polling requests.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.kalshiPollingConcurrency.defaultValue,
    min: 1,
  },
  polymarketPollingConcurrency: {
    group: SettingsGroup.DataQualityStaleness,
    label: 'Polymarket Polling Concurrency',
    description: 'Max concurrent Polymarket API polling requests.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.polymarketPollingConcurrency.defaultValue,
    min: 1,
  },

  // ── Stress Testing ────────────────────────────────────────────────────
  stressTestScenarios: {
    group: SettingsGroup.StressTesting,
    label: 'Scenarios Count',
    description: 'Number of Monte Carlo simulation scenarios.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.stressTestScenarios.defaultValue,
    min: 100,
  },
  stressTestDefaultDailyVol: {
    group: SettingsGroup.StressTesting,
    label: 'Default Daily Volatility',
    description:
      'Default daily volatility assumption when historical data unavailable.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.stressTestDefaultDailyVol.defaultValue,
  },
  stressTestMinSnapshots: {
    group: SettingsGroup.StressTesting,
    label: 'Min Snapshots',
    description:
      'Minimum orderbook snapshots required for historical volatility.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.stressTestMinSnapshots.defaultValue,
    min: 1,
  },

  // ── Auto-Unwind ───────────────────────────────────────────────────────
  autoUnwindEnabled: {
    group: SettingsGroup.AutoUnwind,
    label: 'Auto-Unwind Enabled',
    description: 'Enable automatic single-leg unwind after delay.',
    type: 'boolean',
    envDefault: CONFIG_DEFAULTS.autoUnwindEnabled.defaultValue,
  },
  autoUnwindDelayMs: {
    group: SettingsGroup.AutoUnwind,
    label: 'Auto-Unwind Delay',
    description: 'Delay before auto-unwind triggers on single-leg exposure.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.autoUnwindDelayMs.defaultValue,
    min: 0,
    max: 30000,
    unit: 'ms',
  },
  autoUnwindMaxLossPct: {
    group: SettingsGroup.AutoUnwind,
    label: 'Max Loss Threshold',
    description:
      'Maximum acceptable loss percentage for auto-unwind execution.',
    type: 'float',
    envDefault: CONFIG_DEFAULTS.autoUnwindMaxLossPct.defaultValue,
    min: 0,
    max: 100,
    unit: '%',
  },

  // ── Exit Strategy ─────────────────────────────────────────────────────
  exitMode: {
    group: SettingsGroup.ExitStrategy,
    label: 'Exit Mode',
    description:
      'Exit evaluation mode: fixed thresholds, model-driven, or shadow comparison.',
    type: 'enum',
    envDefault: CONFIG_DEFAULTS.exitMode.defaultValue,
    options: ['fixed', 'model', 'shadow'],
  },
  exitEdgeEvapMultiplier: {
    group: SettingsGroup.ExitStrategy,
    label: 'Edge Evaporation Multiplier',
    description: 'Multiplier for edge evaporation criterion (must be ≤ 0).',
    type: 'float',
    envDefault: CONFIG_DEFAULTS.exitEdgeEvapMultiplier.defaultValue,
    max: 0,
  },
  exitConfidenceDropPct: {
    group: SettingsGroup.ExitStrategy,
    label: 'Confidence Drop Threshold',
    description: 'Percentage drop in confidence score that triggers exit.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitConfidenceDropPct.defaultValue,
    min: 1,
    max: 100,
    unit: '%',
  },
  exitTimeDecayHorizonH: {
    group: SettingsGroup.ExitStrategy,
    label: 'Time Decay Horizon',
    description: 'Hours until resolution — basis for time decay calculation.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitTimeDecayHorizonH.defaultValue,
    min: 1,
    unit: 'hours',
  },
  exitTimeDecaySteepness: {
    group: SettingsGroup.ExitStrategy,
    label: 'Time Decay Steepness',
    description: 'Steepness factor for time decay curve.',
    type: 'float',
    envDefault: CONFIG_DEFAULTS.exitTimeDecaySteepness.defaultValue,
    min: 0.1,
  },
  exitTimeDecayTrigger: {
    group: SettingsGroup.ExitStrategy,
    label: 'Time Decay Trigger',
    description: 'Time decay score threshold that triggers exit (0-1).',
    type: 'float',
    envDefault: CONFIG_DEFAULTS.exitTimeDecayTrigger.defaultValue,
    min: 0,
    max: 1,
  },
  exitRiskBudgetPct: {
    group: SettingsGroup.ExitStrategy,
    label: 'Risk Budget Threshold',
    description: 'Portfolio risk budget percentage threshold for exit.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitRiskBudgetPct.defaultValue,
    min: 0,
    max: 100,
    unit: '%',
  },
  exitRiskRankCutoff: {
    group: SettingsGroup.ExitStrategy,
    label: 'Risk Rank Cutoff',
    description:
      'Dense rank cutoff — positions ranked above this are exit candidates.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitRiskRankCutoff.defaultValue,
    min: 1,
  },
  exitMinDepth: {
    group: SettingsGroup.ExitStrategy,
    label: 'Min Exit Depth',
    description: 'Minimum orderbook depth required to execute exit.',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitMinDepth.defaultValue,
    min: 0,
  },
  exitDepthSlippageTolerance: {
    group: SettingsGroup.ExitStrategy,
    label: 'Exit Depth Slippage Tolerance',
    description:
      'Fraction of VWAP close price to expand depth cutoff. 0 = strict VWAP, 0.02 = 2% band.',
    type: 'decimal',
    envDefault: CONFIG_DEFAULTS.exitDepthSlippageTolerance.defaultValue,
    min: 0,
    max: 1,
  },
  exitMaxChunkSize: {
    group: SettingsGroup.ExitStrategy,
    label: 'Exit Max Chunk Size',
    description:
      'Maximum contracts per exit chunk. 0 = unlimited (full depth-matched size).',
    type: 'integer',
    envDefault: CONFIG_DEFAULTS.exitMaxChunkSize.defaultValue,
    min: 0,
  },
  exitProfitCaptureRatio: {
    group: SettingsGroup.ExitStrategy,
    label: 'Profit Capture Ratio',
    description: 'Fraction of initial edge to capture as profit target.',
    type: 'float',
    envDefault: CONFIG_DEFAULTS.exitProfitCaptureRatio.defaultValue,
    min: 0.01,
    max: 5,
  },
} satisfies Record<keyof typeof CONFIG_DEFAULTS, SettingsMetadataEntry>;

/** All valid SETTINGS_METADATA key names (excludes bankrollUsd for reset) */
export const RESETTABLE_SETTINGS_KEYS = Object.keys(SETTINGS_METADATA).filter(
  (k) => k !== 'bankrollUsd',
);
