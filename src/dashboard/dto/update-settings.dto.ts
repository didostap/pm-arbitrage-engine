/**
 * Story 10-5.2 AC9 — UpdateSettingsDto.
 *
 * PATCH validation DTO for all 71 Category B settings (all optional).
 * Range constraints mirror env.schema.ts Zod constraints.
 * Decimal fields are string type validated with regex.
 */
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Regex for decimal string fields — matches env.schema.ts decimalString() */
const DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

export class UpdateSettingsDto {
  // ── Trading Engine ──────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(1000)
  pollingIntervalMs?: number;

  // ── Detection & Edge (decimal strings) ──────────────────────────────
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  detectionMinEdgeThreshold?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  detectionGasEstimateUsd?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  detectionPositionSizeUsd?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  minAnnualizedReturn?: string;

  // ── Gas Estimation ──────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  gasBufferPercent?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  gasPollIntervalMs?: number;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  gasPolPriceFallbackUsd?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  polymarketSettlementGasUnits?: number;

  // ── Execution ───────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  executionMinFillRatio?: string;

  @IsOptional()
  @IsBoolean()
  adaptiveSequencingEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  adaptiveSequencingLatencyThresholdMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(30000)
  polymarketOrderPollTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(5000)
  polymarketOrderPollIntervalMs?: number;

  // ── Risk Management ─────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  riskMaxPositionPct?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  riskMaxOpenPairs?: number;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  riskDailyLossPct?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  clusterLlmTimeoutMs?: number;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  riskClusterHardLimitPct?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  riskClusterSoftLimitPct?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  riskAggregateClusterLimitPct?: string;

  // ── Telegram ────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  telegramTestAlertCron?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  telegramTestAlertTimezone?: string;

  @IsOptional()
  @IsInt()
  @Min(500)
  telegramSendTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  telegramMaxRetries?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  telegramBufferMaxSize?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  telegramCircuitBreakMs?: number;

  // ── CSV / Logging ───────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  csvEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  auditLogRetentionDays?: number;

  // ── LLM Scoring ─────────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['gemini', 'anthropic'])
  llmPrimaryProvider?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  llmPrimaryModel?: string;

  @IsOptional()
  @IsIn(['gemini', 'anthropic'])
  llmEscalationProvider?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  llmEscalationModel?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  llmEscalationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  llmEscalationMax?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  llmAutoApproveThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  llmMinReviewThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  llmMaxTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  llmTimeoutMs?: number;

  // ── Discovery ───────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  discoveryEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  discoveryRunOnStartup?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  discoveryCronExpression?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  discoveryPrefilterThreshold?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  discoverySettlementWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  discoveryMaxCandidatesPerContract?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  discoveryLlmConcurrency?: number;

  // ── Resolution & Calibration ────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  resolutionPollerEnabled?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  resolutionPollerCronExpression?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  resolutionPollerBatchSize?: number;

  @IsOptional()
  @IsBoolean()
  calibrationEnabled?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  calibrationCronExpression?: string;

  // ── Data Quality & Staleness ────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(1000)
  orderbookStalenessThresholdMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  wsStalenessThresholdMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  kalshiPollingConcurrency?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  polymarketPollingConcurrency?: number;

  // ── Stress Testing ──────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(100)
  stressTestScenarios?: number;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_REGEX)
  stressTestDefaultDailyVol?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  stressTestMinSnapshots?: number;

  // ── Auto-Unwind ─────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  autoUnwindEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30000)
  autoUnwindDelayMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  autoUnwindMaxLossPct?: number;

  // ── Exit Strategy ───────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['fixed', 'model', 'shadow'])
  exitMode?: string;

  @IsOptional()
  @IsNumber()
  @Max(0)
  exitEdgeEvapMultiplier?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  exitConfidenceDropPct?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  exitTimeDecayHorizonH?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  exitTimeDecaySteepness?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  exitTimeDecayTrigger?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  exitRiskBudgetPct?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  exitRiskRankCutoff?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  exitMinDepth?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(5)
  exitProfitCaptureRatio?: number;
}
