import { Inject, Injectable, Logger } from '@nestjs/common';
import { ExecutionLockService } from './execution-lock.service';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
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
          // TODO: Story 5.1 — replace with IExecutionEngine.execute() call
          await this.riskManager.commitReservation(reservation.reservationId);
          return {
            opportunityId,
            reserved: true,
            executed: true,
            committed: true,
          };
        } catch (execError) {
          // Execution or commit failed — release reservation
          try {
            await this.riskManager.releaseReservation(
              reservation.reservationId,
            );
          } catch {
            // Release may fail if commit already consumed it
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
