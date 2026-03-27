import { HistoricalDataSource } from '@prisma/client';

export interface DataQualityFlags {
  hasGaps: boolean;
  hasSuspiciousJumps: boolean;
  hasSurvivorshipBias: boolean;
  hasStaleData: boolean;
  hasLowVolume: boolean;
  gapDetails: Array<{ from: Date; to: Date }>;
  jumpDetails: Array<{ index: number; priceDelta: number }>;
  /** Depth-specific: bid-ask spread >5% detected (Story 10-9-1b) */
  hasWideSpreads?: boolean;
  /** Depth-specific: timestamps and spread in bps where wide spreads detected */
  spreadDetails?: Array<{ timestamp: Date; spreadBps: number }>;
  /** Depth-specific: best bid >= best ask (crossed/locked book) detected */
  hasCrossedBooks?: boolean;
}

export interface IngestionMetadata {
  source: HistoricalDataSource;
  platform: string;
  contractId: string;
  recordCount: number;
  dateRange: { start: Date; end: Date };
  durationMs: number;
}
