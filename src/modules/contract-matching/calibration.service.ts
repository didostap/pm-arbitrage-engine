import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { PrismaService } from '../../common/prisma.service.js';
import {
  EVENT_NAMES,
  CalibrationCompletedEvent,
} from '../../common/events/index.js';
import type {
  CalibrationResult,
  BoundaryAnalysisEntry,
} from '../../common/events/calibration-completed.event.js';

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

  onModuleInit(): void {
    const enabled = this.configService.get<string>(
      'CALIBRATION_ENABLED',
      'true',
    );
    if (enabled !== 'true') {
      this.logger.log({ message: 'Calibration service disabled' });
      return;
    }
    const cronExpr = this.configService.get<string>(
      'CALIBRATION_CRON_EXPRESSION',
      '0 0 7 1 */3 *',
    );
    const job = new CronJob(cronExpr, () => {
      void this.runCalibration();
    });
    this.schedulerRegistry.addCronJob('calibration', job);
    job.start();
    this.logger.log({
      message: 'Calibration service enabled',
      data: { cron: cronExpr },
    });
  }

  getLatestResult(): CalibrationResult | null {
    return this.latestResult;
  }

  async runCalibration(): Promise<CalibrationResult> {
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
