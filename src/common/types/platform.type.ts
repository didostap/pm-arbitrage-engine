export enum PlatformId {
  KALSHI = 'kalshi',
  POLYMARKET = 'polymarket',
}

export interface PlatformHealth {
  platformId: PlatformId;
  status: 'healthy' | 'degraded' | 'disconnected';
  lastHeartbeat: Date | null;
  latencyMs: number | null;
  metadata?: Record<string, unknown>;
  mode?: 'paper' | 'live';
}

export interface OrderParams {
  contractId: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  type: 'limit' | 'market';
}

export interface OrderResult {
  orderId: string;
  platformId: PlatformId;
  status: 'filled' | 'partial' | 'pending' | 'rejected';
  filledQuantity: number;
  filledPrice: number;
  timestamp: Date;
}

export interface CancelResult {
  orderId: string;
  status: 'cancelled' | 'not_found' | 'already_filled';
}

export interface Position {
  contractId: string;
  platformId: PlatformId;
  side: 'yes' | 'no';
  quantity: number;
  averagePrice: number;
  currentValue: number;
}

/**
 * Result from querying an individual order's status on a platform.
 * Used by reconciliation to verify order states without throwing on not-found.
 */
export interface OrderStatusResult {
  orderId: string;
  status:
    | 'filled'
    | 'pending'
    | 'cancelled'
    | 'rejected'
    | 'partial'
    | 'not_found';
  fillPrice?: number;
  fillSize?: number;
  rawResponse?: unknown;
}

/**
 * Platform fee schedule for edge calculation.
 * NOTE: Fee percentages use 0-100 scale (e.g., 2.0 = 2%), NOT decimal scale (0-1).
 * Connectors must convert internal decimal constants (e.g., 0.02) to percentage (2.0).
 */
export interface FeeSchedule {
  platformId: PlatformId;
  makerFeePercent: number; // Percentage: 0-100 scale (e.g., 2.0 = 2% fee)
  takerFeePercent: number; // Percentage: 0-100 scale (e.g., 2.0 = 2% fee)
  description: string;
  gasEstimateUsd?: number; // Dynamic gas estimate in USD (Polymarket only)
}
