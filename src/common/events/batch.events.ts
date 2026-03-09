import { BaseEvent } from './base.event';
import type { BatchPositionResult } from '../interfaces/position-close-service.interface';

export class BatchCompleteEvent extends BaseEvent {
  constructor(
    public readonly batchId: string,
    public readonly results: BatchPositionResult[],
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
