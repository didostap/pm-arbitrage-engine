import { PlatformId } from './platform.type.js';

export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface NormalizedOrderBook {
  platformId: PlatformId;
  contractId: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: Date;
  sequenceNumber?: number;
  platformHealth?: 'healthy' | 'degraded' | 'offline';
}
