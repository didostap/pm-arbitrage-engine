import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { PrismaService } from '../../common/prisma.service.js';
import {
  EVENT_NAMES,
  CalibrationCompletedEvent,
  DataCorruptionDetectedEvent,
} from '../../common/events/index.js';
import type {
  CalibrationResult,
  BoundaryAnalysisEntry,
} from '../../common/events/calibration-completed.event.js';
import { SystemHealthError } from '../../common/errors/system-health-error.js';
import { parseJsonField } from '../../common/schemas/parse-json-field.js';
import {
  calibrationTiersSchema,
  boundaryAnalysisSchema,
  recommendationsSchema,
} from '../../common/schemas/prisma-json.schema.js';

export type { CalibrationResult };

@Injectable()
export class CalibrationService {
  private readonly logger = new Logger(CalibrationService.name);
  private readonly autoApproveThreshold: number;
  private readonly minReviewThreshold: number;
  private latestResult: CalibrationResult | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.autoApproveThreshold = this.configService.get<number>(
      'LLM_AUTO_APPROVE_THRESHOLD',
      85,
    );
    this.minReviewThreshold = this.configService.get<number>(
      'LLM_MIN_REVIEW_THRESHOLD',
      40,
    );
  }

  async onModuleInit(): Promise<void> {
    // Load latest calibration result from DB (survives restarts)
    await this.loadLatestFromDb();

    const enabled =
      this.configService.get<boolean>('CALIBRATION_ENABLED') ?? true;
    if (!enabled) {
      this.logger.log({ message: 'Calibration service disabled' });
      return;
    }
    const cronExpr = this.configService.get<string>(
      'CALIBRATION_CRON_EXPRESSION',
      '0 0 7 1 */3 *',
    );
    const job = new CronJob(cronExpr, () => {
      void this.runCalibration('cron');
    });
    this.schedulerRegistry.addCronJob('calibration', job);
    job.start();
    this.logger.log({
      message: 'Calibration service enabled',
      data: { cron: cronExpr },
    });
  }

  /** Story 10-5.2 AC6: hot-reload cron schedule */
  reloadCron(expression: string): void {
    const jobName = 'calibration';

    // Construct new job BEFORE deleting old — if expression is invalid, old job survives
    let newJob: CronJob;
    try {
      newJob = new CronJob(expression, () => {
        void this.runCalibration('cron');
      });
    } catch (error) {
      this.logger.error({
        message: `Invalid cron expression for '${jobName}', keeping existing schedule`,
        data: {
          expression,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    try {
      this.schedulerRegistry.deleteCronJob(jobName);
    } catch {
      this.logger.warn({
        message: `Cron job '${jobName}' not found for deletion`,
      });
    }

    this.schedulerRegistry.addCronJob(jobName, newJob);
    newJob.start();
    this.logger.log({
      message: `Cron '${jobName}' reloaded`,
      data: { expression },
    });
  }

  getLatestResult(): CalibrationResult | null {
    return this.latestResult;
  }

  async getCalibrationHistory(
    limit: number,
  ): Promise<{ data: CalibrationRunSummary[]; count: number }> {
    const [runs, totalCount] = await Promise.all([
      this.prisma.calibrationRun.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit,
      }),
      this.prisma.calibrationRun.count(),
    ]);

    const data: CalibrationRunSummary[] = runs.map((run) => {
      try {
        return {
          id: run.id,
          timestamp: run.timestamp,
          totalResolvedMatches: run.totalResolvedMatches,
          tiers: parseJsonField(calibrationTiersSchema, run.tiers, {
            model: 'CalibrationRun',
            field: 'tiers',
            recordId: String(run.id),
          }),
          boundaryAnalysis: parseJsonField(
            boundaryAnalysisSchema,
            run.boundaryAnalysis,
            {
              model: 'CalibrationRun',
              field: 'boundaryAnalysis',
              recordId: String(run.id),
            },
          ),
          currentAutoApproveThreshold: run.currentAutoApproveThreshold,
          currentMinReviewThreshold: run.currentMinReviewThreshold,
          recommendations: parseJsonField(
            recommendationsSchema,
            run.recommendations,
            {
              model: 'CalibrationRun',
              field: 'recommendations',
              recordId: String(run.id),
            },
          ),
          minimumDataMet: run.minimumDataMet,
          triggeredBy: run.triggeredBy,
        };
      } catch (error) {
        this.emitDataCorruptionEvent('CalibrationRun', run.id, run, error);
        throw error;
      }
    });

    return { data, count: totalCount };
  }

  async runCalibration(
    triggeredBy: 'cron' | 'operator' = 'cron',
  ): Promise<CalibrationResult> {
    if (this.isRunning) {
      this.logger.warn({
        message: 'Calibration already running, skipping',
      });
      return this.latestResult ?? this.buildEmptyResult();
    }

    this.isRunning = true;

    try {
      const matches = await this.prisma.contractMatch.findMany({
        where: {
          resolutionTimestamp: { not: null },
          confidenceScore: { not: null },
        },
        select: {
          confidenceScore: true,
          resolutionDiverged: true,
        },
      });

      const result: CalibrationResult = {
        timestamp: new Date(),
        totalResolvedMatches: matches.length,
        tiers: {
          autoApprove: {
            range: `>= ${this.autoApproveThreshold}`,
            matchCount: 0,
            divergedCount: 0,
            divergenceRate: 0,
          },
          pendingReview: {
            range: `${this.minReviewThreshold} - ${this.autoApproveThreshold - 1}`,
            matchCount: 0,
            divergedCount: 0,
            divergenceRate: 0,
          },
          autoReject: {
            range: `< ${this.minReviewThreshold}`,
            matchCount: 0,
            divergedCount: 0,
            divergenceRate: 0,
          },
        },
        boundaryAnalysis: [],
        currentAutoApproveThreshold: this.autoApproveThreshold,
        currentMinReviewThreshold: this.minReviewThreshold,
        recommendations: [],
        minimumDataMet: matches.length >= 10,
      };

      if (matches.length < 10) {
        result.recommendations.push(
          `Insufficient data for calibration (${matches.length}/10 required)`,
        );
        this.latestResult = result;
        await this.persistCalibrationRun(result, triggeredBy);
        this.emitAndLog(result);
        return result;
      }

      // Classify into tiers
      for (const match of matches) {
        const score = match.confidenceScore!;
        const diverged = match.resolutionDiverged === true;

        if (score >= this.autoApproveThreshold) {
          result.tiers.autoApprove.matchCount++;
          if (diverged) result.tiers.autoApprove.divergedCount++;
        } else if (score >= this.minReviewThreshold) {
          result.tiers.pendingReview.matchCount++;
          if (diverged) result.tiers.pendingReview.divergedCount++;
        } else {
          result.tiers.autoReject.matchCount++;
          if (diverged) result.tiers.autoReject.divergedCount++;
        }
      }

      // Compute divergence rates
      for (const tier of Object.values(result.tiers)) {
        tier.divergenceRate =
          tier.matchCount > 0
            ? Number(((tier.divergedCount / tier.matchCount) * 100).toFixed(1))
            : 0;
      }

      // Boundary analysis: test thresholds at 5-point decrements down to floor of 75
      const safetyFloor = 75;
      for (
        let threshold = this.autoApproveThreshold - 5;
        threshold >= safetyFloor;
        threshold -= 5
      ) {
        const above = matches.filter((m) => m.confidenceScore! >= threshold);
        const divergedAbove = above.filter(
          (m) => m.resolutionDiverged === true,
        );
        const rate =
          above.length > 0
            ? Number(((divergedAbove.length / above.length) * 100).toFixed(1))
            : 0;

        const entry: BoundaryAnalysisEntry = {
          threshold,
          matchesAbove: above.length,
          divergedAbove: divergedAbove.length,
          divergenceRateAbove: rate,
          recommendation: null,
        };

        if (rate === 0 && above.length >= 10) {
          entry.recommendation = `Auto-approve threshold could be lowered to ${threshold} based on 0% divergence rate in ${threshold}-${this.autoApproveThreshold - 1} band over ${above.length} resolved matches`;
        }

        result.boundaryAnalysis.push(entry);
      }

      // Generate recommendations
      if (result.tiers.autoApprove.divergenceRate > 5) {
        result.recommendations.push(
          `High divergence in auto-approve tier (${result.tiers.autoApprove.divergenceRate}%). Consider raising auto-approve threshold above ${this.autoApproveThreshold}.`,
        );
      }

      // Safety: never recommend below 75 or above 95
      const lowestViable = result.boundaryAnalysis.find(
        (b) => b.recommendation && b.threshold >= 75 && b.threshold <= 95,
      );
      if (lowestViable?.recommendation) {
        result.recommendations.push(lowestViable.recommendation);
      }

      this.latestResult = result;
      await this.persistCalibrationRun(result, triggeredBy);
      this.emitAndLog(result);
      return result;
    } catch (error) {
      this.logger.error({
        message: 'Calibration failed unexpectedly',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return (
        this.latestResult ??
        this.buildEmptyResult(['Calibration failed — see logs for details'])
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async loadLatestFromDb(): Promise<void> {
    try {
      const dbResult = await this.prisma.calibrationRun.findFirst({
        orderBy: { timestamp: 'desc' },
      });
      if (dbResult) {
        try {
          this.latestResult = {
            timestamp: dbResult.timestamp,
            totalResolvedMatches: dbResult.totalResolvedMatches,
            tiers: parseJsonField(calibrationTiersSchema, dbResult.tiers, {
              model: 'CalibrationRun',
              field: 'tiers',
              recordId: String(dbResult.id),
            }),
            boundaryAnalysis: parseJsonField(
              boundaryAnalysisSchema,
              dbResult.boundaryAnalysis,
              {
                model: 'CalibrationRun',
                field: 'boundaryAnalysis',
                recordId: String(dbResult.id),
              },
            ),
            currentAutoApproveThreshold: dbResult.currentAutoApproveThreshold,
            currentMinReviewThreshold: dbResult.currentMinReviewThreshold,
            recommendations: parseJsonField(
              recommendationsSchema,
              dbResult.recommendations,
              {
                model: 'CalibrationRun',
                field: 'recommendations',
                recordId: String(dbResult.id),
              },
            ),
            minimumDataMet: dbResult.minimumDataMet,
          };
        } catch (error) {
          this.emitDataCorruptionEvent(
            'CalibrationRun',
            dbResult.id,
            dbResult,
            error,
          );
          throw error;
        }
        this.logger.log({
          message: 'Loaded latest calibration result from database',
          data: {
            timestamp: dbResult.timestamp.toISOString(),
            totalResolvedMatches: dbResult.totalResolvedMatches,
          },
        });
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to load calibration result from database',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async persistCalibrationRun(
    result: CalibrationResult,
    triggeredBy: 'cron' | 'operator',
  ): Promise<void> {
    try {
      await this.prisma.calibrationRun.create({
        data: {
          timestamp: result.timestamp,
          totalResolvedMatches: result.totalResolvedMatches,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          tiers: JSON.parse(JSON.stringify(result.tiers)),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          boundaryAnalysis: JSON.parse(JSON.stringify(result.boundaryAnalysis)),
          currentAutoApproveThreshold: result.currentAutoApproveThreshold,
          currentMinReviewThreshold: result.currentMinReviewThreshold,
          recommendations: result.recommendations,
          minimumDataMet: result.minimumDataMet,
          triggeredBy,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist calibration run',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private buildEmptyResult(recommendations: string[] = []): CalibrationResult {
    return {
      timestamp: new Date(),
      totalResolvedMatches: 0,
      tiers: {
        autoApprove: {
          range: `>= ${this.autoApproveThreshold}`,
          matchCount: 0,
          divergedCount: 0,
          divergenceRate: 0,
        },
        pendingReview: {
          range: `${this.minReviewThreshold} - ${this.autoApproveThreshold - 1}`,
          matchCount: 0,
          divergedCount: 0,
          divergenceRate: 0,
        },
        autoReject: {
          range: `< ${this.minReviewThreshold}`,
          matchCount: 0,
          divergedCount: 0,
          divergenceRate: 0,
        },
      },
      boundaryAnalysis: [],
      currentAutoApproveThreshold: this.autoApproveThreshold,
      currentMinReviewThreshold: this.minReviewThreshold,
      recommendations,
      minimumDataMet: false,
    };
  }

  private emitDataCorruptionEvent(
    model: string,
    recordId: string,
    rawValue: unknown,
    error: unknown,
  ): void {
    const zodErrors =
      error instanceof SystemHealthError
        ? ((error.metadata?.zodErrors as import('zod').ZodIssue[]) ?? [])
        : [];
    this.eventEmitter.emit(
      EVENT_NAMES.DATA_CORRUPTION_DETECTED,
      new DataCorruptionDetectedEvent(
        model,
        'tiers|boundaryAnalysis|recommendations',
        String(recordId),
        rawValue,
        zodErrors,
      ),
    );
  }

  private emitAndLog(result: CalibrationResult): void {
    this.eventEmitter.emit(
      EVENT_NAMES.CALIBRATION_COMPLETED,
      new CalibrationCompletedEvent(result),
    );
    this.logger.log({
      message: 'Calibration completed',
      data: result,
    });
  }
}

export interface CalibrationRunSummary {
  id: string;
  timestamp: Date;
  totalResolvedMatches: number;
  tiers: CalibrationResult['tiers'];
  boundaryAnalysis: BoundaryAnalysisEntry[];
  currentAutoApproveThreshold: number;
  currentMinReviewThreshold: number;
  recommendations: string[];
  minimumDataMet: boolean;
  triggeredBy: string;
}
