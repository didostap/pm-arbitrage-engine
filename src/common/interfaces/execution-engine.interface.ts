import { BudgetReservation, RankedOpportunity } from '../types/risk.type.js';
import { ExecutionError } from '../errors/execution-error.js';
import { OrderResult } from '../types/platform.type.js';

export interface ExecutionResult {
  success: boolean;
  partialFill: boolean;
  positionId?: string;
  primaryOrder?: OrderResult;
  secondaryOrder?: OrderResult;
  error?: ExecutionError;
}

export interface IExecutionEngine {
  execute(
    opportunity: RankedOpportunity,
    reservation: BudgetReservation,
  ): Promise<ExecutionResult>;
}
