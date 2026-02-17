import { ExecutionQueueResult, RankedOpportunity } from '../types/risk.type.js';

export interface IExecutionQueue {
  processOpportunities(
    opportunities: RankedOpportunity[],
  ): Promise<ExecutionQueueResult[]>;
}
