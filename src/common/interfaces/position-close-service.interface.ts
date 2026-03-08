export const POSITION_CLOSE_SERVICE_TOKEN = 'IPositionCloseService';

export interface PositionCloseResult {
  success: boolean;
  realizedPnl?: string;
  error?: string;
  errorCode?: 'NOT_FOUND' | 'NOT_CLOSEABLE' | 'EXECUTION_FAILED';
}

export interface IPositionCloseService {
  closePosition(
    positionId: string,
    rationale?: string,
  ): Promise<PositionCloseResult>;
}
