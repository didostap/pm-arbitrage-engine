/**
 * WebSocket event payload interfaces for dashboard real-time updates.
 * These are TypeScript interfaces (NOT class-validator DTOs) for type safety.
 * Manually maintained in both backend and frontend repos.
 */

export interface WsHealthChangePayload {
  platformId: string;
  status: 'healthy' | 'degraded' | 'disconnected' | 'initializing';
  apiConnected: boolean;
  dataFresh: boolean;
  lastUpdate: string;
  mode: 'live' | 'paper';
}

export interface WsExecutionCompletePayload {
  orderId: string;
  platform: string;
  side: string;
  status: 'filled' | 'failed';
  positionId: string | null;
  isPaper: boolean;
}

export interface WsAlertNewPayload {
  id: string;
  type:
    | 'single_leg_exposure'
    | 'risk_limit_breached'
    | 'risk_limit_approached'
    | 'cluster_limit_breached'
    | 'aggregate_cluster_limit_breached'
    | 'auto_unwind';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: string;
  /** Auto-unwind fields — present only on auto_unwind alerts (backward-compatible) */
  autoUnwindAttempted?: boolean;
  autoUnwindAction?: string | null;
  autoUnwindResult?: string | null;
  autoUnwindLossAmount?: string | null;
  autoUnwindTimeElapsedMs?: number | null;
  autoUnwindSimulated?: boolean;
}

/** Lightweight payload — frontend refetches enriched data via REST on receiving this */
export interface WsPositionUpdatePayload {
  positionId: string;
  status: string;
  timestamp: string;
}

export interface WsMatchPendingPayload {
  matchId: string;
  status: string;
  confidenceScore: number | null;
}

export interface WsEventEnvelope<T> {
  event: string;
  data: T;
  timestamp: string;
}

export interface WsBatchCompletePayload {
  batchId: string;
  results: Array<{
    positionId: string;
    pairName: string;
    status: string;
    realizedPnl?: string;
    error?: string;
  }>;
}

export interface WsTradingHaltPayload {
  halted: boolean;
  reasons: string[];
}

export interface WsShadowComparisonPayload {
  positionId: string;
  pairId: string;
  modelTriggered: boolean;
  fixedTriggered: boolean;
  modelPnl: string;
  fixedPnl: string;
}

export interface WsShadowDailySummaryPayload {
  date: string;
  totalComparisons: number;
  fixedTriggerCount: number;
  modelTriggerCount: number;
  cumulativePnlDelta: string;
}

export const WS_EVENTS = {
  HEALTH_CHANGE: 'health.change',
  EXECUTION_COMPLETE: 'execution.complete',
  ALERT_NEW: 'alert.new',
  POSITION_UPDATE: 'position.update',
  MATCH_PENDING: 'match.pending',
  BATCH_COMPLETE: 'batch.complete',
  CONFIG_BANKROLL_UPDATED: 'config.bankroll.updated',
  DIVERGENCE_ALERT: 'divergence.alert',
  TRADING_HALT: 'trading.halt',
  SHADOW_COMPARISON: 'shadow.comparison',
  SHADOW_DAILY_SUMMARY: 'shadow.daily_summary',
  AUTO_UNWIND: 'auto_unwind.result',
} as const;
