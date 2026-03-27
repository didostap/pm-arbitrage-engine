/** Standard decimal precision for all metric serialization in reports */
export const REPORT_DECIMAL_PRECISION = 10;
/** Standard precision for hours/USD amounts */
export const REPORT_DECIMAL_PRECISION_SHORT = 6;

export const KNOWN_LIMITATIONS: string[] = [
  'No single-leg risk modeling — assumes atomic dual-leg fills',
  'No market impact — ignores price movement from our orders',
  'No queue position modeling — taker-only assumptions',
  'Depth interpolation — hourly PMXT snapshots use nearest-neighbor between hours',
  'No correlation modeling — independent position evaluation',
  'No funding/holding costs — ignores capital opportunity cost',
  'Execution latency not modeled — assumes instant fills',
  'Historical data biases — survivorship bias (only resolved markets), lookback bias (pairs applied retroactively)',
  'Cross-platform clock skew — Kalshi server time vs Polymarket blockchain time (minutes of divergence possible)',
  'Non-binary resolution excluded — void/refunded/fractional resolution not modeled',
];

export interface CalibrationReport {
  summaryMetrics: SummaryMetrics;
  confidenceIntervals: BootstrapCIResult;
  knownLimitations: string[];
  dataQualitySummary: DataQualitySummary;
  generatedAt: string; // ISO 8601
}

export interface SummaryMetrics {
  totalTrades: number;
  profitFactor: string | null; // Decimal serialized
  netPnl: string;
  maxDrawdown: string;
  sharpeRatio: string | null;
  winRate: number; // 0.0–1.0
  avgEdgeCapturedVsExpected: string; // ratio
}

export interface BootstrapCIResult {
  iterations: number;
  confidence: number; // 0.95
  profitFactor: { lower: string; upper: string } | null;
  sharpeRatio: { lower: string; upper: string } | null;
}

export interface DataQualitySummary {
  pairCount: number;
  totalDataPoints: number;
  coverageGaps: CoverageGapEntry[];
  excludedPeriods: ExcludedPeriod[];
  dateRange: { start: string; end: string };
}

export interface CoverageGapEntry {
  platform: string;
  contractId: string;
  gapCount: number;
  totalGapMinutes: number;
}

export interface ExcludedPeriod {
  start: string;
  end: string;
  reason: string;
}

export interface WalkForwardResults {
  trainPct: number;
  testPct: number;
  trainDateRange: { start: string; end: string };
  testDateRange: { start: string; end: string };
  trainMetrics: SerializedMetrics;
  testMetrics: SerializedMetrics;
  degradation: DegradationResult;
  overfitFlags: string[]; // metric names with >30% degradation
}

export interface DegradationResult {
  profitFactor: number | null; // percentage degradation (0.0–1.0)
  sharpeRatio: number | null;
  totalPnl: number | null;
}

export interface SerializedMetrics {
  totalPositions: number;
  winCount: number;
  lossCount: number;
  totalPnl: string;
  maxDrawdown: string;
  sharpeRatio: string | null;
  profitFactor: string | null;
  avgHoldingHours: string;
  capitalUtilization: string;
}

export interface SensitivityResults {
  sweeps: ParameterSweep[];
  degradationBoundaries: DegradationBoundary[];
  recommendedParameters: RecommendedParameters;
  partial: boolean; // true if timeout interrupted before all sweeps completed
  completedSweeps: number;
  totalPlannedSweeps: number;
}

export interface ParameterSweep {
  parameterName: string;
  baseValue: number;
  values: number[];
  profitFactor: (string | null)[];
  maxDrawdown: string[];
  sharpeRatio: (string | null)[];
  totalPnl: string[];
}

export interface DegradationBoundary {
  parameterName: string;
  breakEvenValue: number | null; // value where profitFactor < 1.0
  direction: 'below' | 'above'; // "below X, system is unprofitable"
  description: string;
}

export interface RecommendedParameters {
  byProfitFactor: {
    parameterName: string;
    value: number;
    profitFactor: string;
  }[];
  bySharpe: { parameterName: string; value: number; sharpeRatio: string }[];
}

export interface SweepConfig {
  edgeThresholdRange?: { min: number; max: number; step: number };
  positionSizeRange?: { min: number; max: number; step: number };
  maxConcurrentPairsRange?: { min: number; max: number; step: number };
  tradingWindowVariants?: {
    startHour: number;
    endHour: number;
    label: string;
  }[];
  timeoutSeconds?: number; // default 1800 (30 min)
}
