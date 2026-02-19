import { Inject, Injectable, Logger } from '@nestjs/common';
import { ExecutionLockService } from './execution-lock.service';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { EXECUTION_ENGINE_TOKEN } from './execution.constants';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import type { IExecutionEngine } from '../../common/interfaces/execution-engine.interface';
import {
  ExecutionQueueResult,
  RankedOpportunity,
} from '../../common/types/risk.type';
import { IExecutionQueue } from '../../common/interfaces/execution-queue.interface';

@Injectable()
export class ExecutionQueueService implements IExecutionQueue {
  private readonly logger = new Logger(ExecutionQueueService.name);

  constructor(
    private readonly lockService: ExecutionLockService,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    @Inject(EXECUTION_ENGINE_TOKEN)
    private readonly executionEngine: IExecutionEngine,
  ) {}

  async processOpportunities(
    opportunities: RankedOpportunity[],
  ): Promise<ExecutionQueueResult[]> {
    if (opportunities.length === 0) {
      return [];
    }

    const results: ExecutionQueueResult[] = [];

    for (const ranked of opportunities) {
      const result = await this.processOneOpportunity(ranked);
      results.push(result);
    }

    return results;
  }

  private async processOneOpportunity(
    ranked: RankedOpportunity,
  ): Promise<ExecutionQueueResult> {
    const { reservationRequest } = ranked;
    const opportunityId = reservationRequest.opportunityId;

    try {
      await this.lockService.acquire();

      try {
        // Reserve budget (validates + reserves atomically)
        const reservation =
          await this.riskManager.reserveBudget(reservationRequest);

        try {
          const result = await this.executionEngine.execute(
            ranked,
            reservation,
          );

          // Commit/release based on execution result:
          // - success → commit (both legs filled)
          // - partialFill → commit (money is deployed on one leg)
          // - full failure → release
          if (result.success || result.partialFill) {
            await this.riskManager.commitReservation(reservation.reservationId);
            return {
              opportunityId,
              reserved: true,
              executed: result.success,
              committed: true,
              error: result.error?.message,
            };
          } else {
            await this.riskManager.releaseReservation(
              reservation.reservationId,
            );
            return {
              opportunityId,
              reserved: true,
              executed: false,
              committed: false,
              error: result.error?.message,
            };
          }
        } catch (execError) {
          // Unexpected execution error — release reservation
          try {
            await this.riskManager.releaseReservation(
              reservation.reservationId,
            );
          } catch {
            // Release may fail if commit already consumed it
          }

          if (execError instanceof Error) {
            this.logger.error({
              message: 'Execution failed unexpectedly',
              data: { opportunityId, error: execError.message },
            });
          }

          return {
            opportunityId,
            reserved: true,
            executed: false,
            committed: false,
            error:
              execError instanceof Error
                ? execError.message
                : String(execError),
          };
        }
      } catch (reserveError) {
        // Budget reservation failed
        this.logger.warn({
          message: 'Budget reservation failed for opportunity',
          data: {
            opportunityId,
            error:
              reserveError instanceof Error
                ? reserveError.message
                : String(reserveError),
          },
        });
        return {
          opportunityId,
          reserved: false,
          executed: false,
          committed: false,
          error:
            reserveError instanceof Error
              ? reserveError.message
              : String(reserveError),
        };
      }
    } finally {
      this.lockService.release();
    }
  }
}
