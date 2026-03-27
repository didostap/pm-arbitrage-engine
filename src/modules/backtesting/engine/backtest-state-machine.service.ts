import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { type BacktestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  BacktestRunStartedEvent,
  BacktestRunFailedEvent,
  BacktestRunCancelledEvent,
  BacktestEngineStateChangedEvent,
} from '../../../common/events/backtesting.events';
import type {
  IBacktestConfig,
  BacktestRunStatus,
} from '../../../common/interfaces/backtest-engine.interface';

const VALID_TRANSITIONS: Record<string, string[]> = {
  IDLE: ['CONFIGURING'],
  CONFIGURING: ['LOADING_DATA', 'FAILED'],
  LOADING_DATA: ['SIMULATING', 'FAILED'],
  SIMULATING: ['GENERATING_REPORT', 'FAILED'],
  GENERATING_REPORT: ['COMPLETE', 'FAILED'],
  COMPLETE: ['IDLE'],
  FAILED: ['IDLE'],
  CANCELLED: ['IDLE'],
};

const CANCELLABLE_STATES = new Set([
  'CONFIGURING',
  'LOADING_DATA',
  'SIMULATING',
  'GENERATING_REPORT',
]);

@Injectable()
export class BacktestStateMachineService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BacktestStateMachineService.name);
  /** Cleanup: .delete(runId) on cleanupRun, .clear() on onModuleDestroy */
  private readonly runStatuses = new Map<string, BacktestRunStatus>();
  /** Cleanup: .delete(runId) in cleanupRun, .clear() on onModuleDestroy */
  private readonly cancelledRuns = new Set<string>();
  readonly maxConcurrentRuns: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    const raw = this.configService.get<string>('backtesting.maxConcurrentRuns');
    const parsed = raw != null ? Number(raw) : NaN;
    this.maxConcurrentRuns = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }

  async onModuleInit(): Promise<void> {
    const orphaned = await this.prisma.backtestRun.findMany({
      where: {
        status: {
          in: [
            'CONFIGURING',
            'LOADING_DATA',
            'SIMULATING',
            'GENERATING_REPORT',
          ],
        },
      },
    });

    for (const run of orphaned) {
      const config = run.config as Record<string, any>;
      const timeoutSeconds =
        typeof config?.timeoutSeconds === 'number'
          ? config.timeoutSeconds
          : 300;
      const timeoutMs = timeoutSeconds * 2 * 1000;
      const elapsed = Date.now() - run.startedAt.getTime();
      if (elapsed > timeoutMs) {
        await this.prisma.backtestRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            errorMessage: 'Orphaned run recovered on startup',
            completedAt: new Date(),
          },
        });
        this.logger.warn(`Recovered orphaned backtest run: ${run.id}`);
      }
    }
  }

  onModuleDestroy(): void {
    this.runStatuses.clear();
    this.cancelledRuns.clear();
  }

  validateTransition(from: string, to: string): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR,
        `Invalid state transition: ${from} → ${to}`,
        'error',
        'backtest-engine',
      );
    }
  }

  getActiveRunCount(): number {
    return [...this.runStatuses.values()].filter(
      (s) =>
        s.status !== 'COMPLETE' &&
        s.status !== 'FAILED' &&
        s.status !== 'CANCELLED',
    ).length;
  }

  async createRun(config: IBacktestConfig): Promise<string> {
    if (this.getActiveRunCount() >= this.maxConcurrentRuns) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR,
        `Max concurrent runs (${this.maxConcurrentRuns}) reached`,
        'error',
        'backtest-engine',
      );
    }

    const run = await this.prisma.backtestRun.create({
      data: {
        status: 'CONFIGURING',
        config: config as unknown as Prisma.InputJsonValue,
        dateRangeStart: new Date(config.dateRangeStart),
        dateRangeEnd: new Date(config.dateRangeEnd),
        startedAt: new Date(),
      },
    });

    const runId = run.id;
    this.runStatuses.set(runId, {
      runId,
      status: 'CONFIGURING' as BacktestStatus,
    });

    this.emitStateChange(runId, 'IDLE', 'CONFIGURING');
    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_RUN_STARTED,
      new BacktestRunStartedEvent({ runId, config: { ...config } }),
    );

    return runId;
  }

  async cancelRun(runId: string): Promise<void> {
    const status = this.runStatuses.get(runId);
    if (!status) return;
    if (!CANCELLABLE_STATES.has(status.status)) return;

    this.cancelledRuns.add(runId);
    this.transitionRun(runId, 'CANCELLED');
    await this.prisma.backtestRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_RUN_CANCELLED,
      new BacktestRunCancelledEvent({ runId }),
    );
  }

  getRunStatus(runId: string): BacktestRunStatus | null {
    return this.runStatuses.get(runId) ?? null;
  }

  isCancelled(runId: string): boolean {
    return this.cancelledRuns.has(runId);
  }

  transitionRun(runId: string, to: BacktestStatus): void {
    const current = this.runStatuses.get(runId);
    const from = current?.status ?? 'IDLE';

    if (to === 'CANCELLED') {
      // Cancel from any cancellable state — bypass normal validation
    } else {
      this.validateTransition(from, to);
    }

    this.runStatuses.set(runId, { runId, status: to });
    this.emitStateChange(runId, from, to);
  }

  async failRun(
    runId: string,
    errorCode: number,
    message: string,
  ): Promise<void> {
    const currentStatus = this.runStatuses.get(runId);
    const fromState = currentStatus?.status ?? 'IDLE';
    this.runStatuses.set(runId, {
      runId,
      status: 'FAILED' as BacktestStatus,
      error: message,
    });
    this.emitStateChange(runId, fromState, 'FAILED');

    try {
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          errorMessage: `[${errorCode}] ${message}`,
          completedAt: new Date(),
        },
      });
    } catch (dbErr: unknown) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      this.logger.error(
        `Failed to persist failure state for run ${runId}: ${msg}`,
      );
    }

    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_RUN_FAILED,
      new BacktestRunFailedEvent({ runId, errorCode, message }),
    );
  }

  cleanupRun(runId: string): void {
    this.runStatuses.delete(runId);
    this.cancelledRuns.delete(runId);
  }

  private emitStateChange(runId: string, from: string, to: string): void {
    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_ENGINE_STATE_CHANGED,
      new BacktestEngineStateChangedEvent({
        runId,
        fromState: from,
        toState: to,
      }),
    );
  }
}
