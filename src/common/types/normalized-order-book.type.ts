import type { ContractId } from './branded.type.js';
import { PlatformId } from './platform.type.js';

export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface NormalizedOrderBook {
  platformId: PlatformId;
  contractId: ContractId;
  /** Sorted best-to-worst: descending by price (highest first). Connectors must maintain this invariant. */
  bids: PriceLevel[];
  /** Sorted best-to-worst: ascending by price (lowest first). Connectors must maintain this invariant. */
  asks: PriceLevel[];
  timestamp: Date;
  sequenceNumber?: number;
  platformHealth?: 'healthy' | 'degraded' | 'offline';
}
