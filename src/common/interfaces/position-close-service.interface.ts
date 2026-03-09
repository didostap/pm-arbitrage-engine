export const POSITION_CLOSE_SERVICE_TOKEN = 'IPositionCloseService';

export interface PositionCloseResult {
  success: boolean;
  realizedPnl?: string;
  error?: string;
  errorCode?:
    | 'NOT_FOUND'
    | 'NOT_CLOSEABLE'
    | 'EXECUTION_FAILED'
    | 'RATE_LIMITED';
}

export interface BatchPositionResult {
  positionId: string;
  pairName: string;
  status: 'success' | 'failure' | 'rate_limited';
  realizedPnl?: string;
  error?: string;
}

export interface IPositionCloseService {
  closePosition(
    positionId: string,
    rationale?: string,
  ): Promise<PositionCloseResult>;

  closeAllPositions(rationale?: string): Promise<{ batchId: string }>;
}
