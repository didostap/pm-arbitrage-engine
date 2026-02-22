import { PlatformId } from '../../common/types/platform.type';

export interface PaperTradingConfig {
  platformId: PlatformId;
  fillLatencyMs: number;
  slippageBps: number;
}

export interface SimulatedOrder {
  orderId: string;
  platformId: PlatformId;
  contractId: string;
  side: 'buy' | 'sell';
  requestedPrice: number;
  filledPrice: number;
  quantity: number;
  status: 'filled' | 'cancelled';
  timestamp: Date;
}

/** Maximum in-memory order retention before LRU eviction */
export const PAPER_MAX_ORDERS = 10_000;
