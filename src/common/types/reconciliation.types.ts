import { PositionStatus } from '@prisma/client';
import type { PairId, PositionId } from './branded.type.js';

export interface ReconciliationContext {
  recommendedStatus: PositionStatus;
  discrepancyType:
    | 'order_status_mismatch'
    | 'order_not_found'
    | 'pending_filled'
    | 'platform_unavailable';
  platformState: Record<string, unknown>;
  detectedAt: string;
}

export interface ReconciliationResult {
  positionsChecked: number;
  ordersVerified: number;
  pendingOrdersResolved: number;
  discrepanciesFound: number;
  durationMs: number;
  platformsUnavailable: string[];
  discrepancies: ReconciliationDiscrepancy[];
}

export interface ReconciliationDiscrepancy {
  positionId: PositionId;
  pairId: PairId;
  discrepancyType: ReconciliationContext['discrepancyType'];
  localState: string;
  platformState: string;
  recommendedAction: string;
}
