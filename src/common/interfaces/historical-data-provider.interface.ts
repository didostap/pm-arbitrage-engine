import { HistoricalDataSource } from '@prisma/client';
import type { IngestionMetadata } from '../types/historical-data.types';

export interface IHistoricalDataProvider {
  ingestPrices(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata>;

  ingestTrades(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata>;

  getSupportedSources(): HistoricalDataSource[];
}

export const HISTORICAL_DATA_PROVIDER_TOKEN = Symbol('IHistoricalDataProvider');
