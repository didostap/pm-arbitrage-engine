/**
 * WebSocket event payload interfaces for dashboard real-time updates.
 * These are TypeScript interfaces (NOT class-validator DTOs) for type safety.
 * Manually maintained in both backend and frontend repos.
 */

export interface WsHealthChangePayload {
  platformId: string;
  status: 'healthy' | 'degraded' | 'disconnected';
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
  type: 'single_leg_exposure' | 'risk_limit_breached' | 'risk_limit_approached';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: string;
}

export interface WsPositionUpdatePayload {
  positionId: string;
  pairName: string;
  status: string;
  currentEdge: string | null;
  unrealizedPnl: string | null;
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

export const WS_EVENTS = {
  HEALTH_CHANGE: 'health.change',
  EXECUTION_COMPLETE: 'execution.complete',
  ALERT_NEW: 'alert.new',
  POSITION_UPDATE: 'position.update',
  MATCH_PENDING: 'match.pending',
} as const;
