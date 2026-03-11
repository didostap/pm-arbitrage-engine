import type { ContractId } from './branded.type.js';
import { PlatformId } from './platform.type.js';

export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface NormalizedOrderBook {
  platformId: PlatformId;
  contractId: ContractId;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: Date;
  sequenceNumber?: number;
  platformHealth?: 'healthy' | 'degraded' | 'offline';
}
