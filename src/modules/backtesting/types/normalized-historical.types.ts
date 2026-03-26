import Decimal from 'decimal.js';
import { HistoricalDataSource } from '@prisma/client';

export type {
  DataQualityFlags,
  IngestionMetadata,
} from '../../../common/types/historical-data.types';

export interface NormalizedPrice {
  platform: string;
  contractId: string;
  source: HistoricalDataSource;
  intervalMinutes: number;
  timestamp: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal | null;
  openInterest: Decimal | null;
}

export interface NormalizedTrade {
  platform: string;
  contractId: string;
  source: HistoricalDataSource;
  externalTradeId: string | null;
  price: Decimal;
  size: Decimal;
  side: string;
  timestamp: Date;
}
