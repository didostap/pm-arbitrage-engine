export type FreshStatus = 'fresh' | 'warning' | 'stale' | 'never';

export interface DataSourceFreshnessDto {
  source: string;
  lastSuccessfulAt: string | null;
  lastAttemptAt: string | null;
  recordsFetched: number;
  contractsUpdated: number;
  status: string;
  errorMessage: string | null;
  freshStatus: FreshStatus;
  stalenessThresholdMs: number;
  timeSinceLastSuccessMs: number | null;
  latestDataTimestamp: string | null;
}

export interface FreshnessResponseDto {
  sources: DataSourceFreshnessDto[];
  overallFresh: boolean;
  staleSources: string[];
  nextScheduledRun: string | null;
}

/** Staleness threshold mapping: source → config key */
export const SOURCE_THRESHOLD_MAP: Record<string, string> = {
  KALSHI_API: 'STALENESS_THRESHOLD_PLATFORM_MS',
  POLYMARKET_API: 'STALENESS_THRESHOLD_PLATFORM_MS',
  GOLDSKY: 'STALENESS_THRESHOLD_PLATFORM_MS',
  PMXT_ARCHIVE: 'STALENESS_THRESHOLD_PMXT_MS',
  ODDSPIPE: 'STALENESS_THRESHOLD_ODDSPIPE_MS',
  PREDEXON: 'STALENESS_THRESHOLD_VALIDATION_MS',
};

export function getThresholdKey(source: string): string {
  return SOURCE_THRESHOLD_MAP[source] ?? 'STALENESS_THRESHOLD_PLATFORM_MS';
}

export function computeFreshStatus(
  lastSuccessfulAt: Date | null,
  thresholdMs: number,
  nowMs: number,
): FreshStatus {
  if (!lastSuccessfulAt) return 'never';
  if (thresholdMs <= 0) return 'stale';
  const ageMs = nowMs - lastSuccessfulAt.getTime();
  if (ageMs > thresholdMs) return 'stale';
  if (ageMs > thresholdMs * 0.5) return 'warning';
  return 'fresh';
}
