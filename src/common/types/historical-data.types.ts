import { HistoricalDataSource } from '@prisma/client';

export interface DataQualityFlags {
  hasGaps: boolean;
  hasSuspiciousJumps: boolean;
  hasSurvivorshipBias: boolean;
  hasStaleData: boolean;
  hasLowVolume: boolean;
  gapDetails: Array<{ from: Date; to: Date }>;
  jumpDetails: Array<{ index: number; priceDelta: number }>;
}

export interface IngestionMetadata {
  source: HistoricalDataSource;
  platform: string;
  contractId: string;
  recordCount: number;
  dateRange: { start: Date; end: Date };
  durationMs: number;
}
