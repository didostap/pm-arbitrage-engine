import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { BacktestTimeStep } from '../types/simulation.types';
import type { AggregateMetrics } from '../engine/backtest-portfolio.service';
import type {
  WalkForwardResults,
  DegradationResult,
  SerializedMetrics,
} from '../types/calibration-report.types';
import {
  REPORT_DECIMAL_PRECISION,
  REPORT_DECIMAL_PRECISION_SHORT,
} from '../types/calibration-report.types';

const OVERFIT_THRESHOLD = 0.3; // >30% degradation

@Injectable()
export class WalkForwardService {
  splitTimeSteps(
    timeSteps: BacktestTimeStep[],
    trainPct: number,
  ): { train: BacktestTimeStep[]; test: BacktestTimeStep[] } {
    const splitIdx = Math.floor(timeSteps.length * trainPct);
    return {
      train: timeSteps.slice(0, splitIdx),
      test: timeSteps.slice(splitIdx),
    };
  }

  compareMetrics(
    train: AggregateMetrics,
    test: AggregateMetrics,
  ): { degradation: DegradationResult; overfitFlags: string[] } {
    const pfDeg = this.computeDegradation(
      train.profitFactor,
      test.profitFactor,
    );
    const sharpeDeg = this.computeDegradation(
      train.sharpeRatio,
      test.sharpeRatio,
    );
    const pnlDeg = this.computeDegradation(train.totalPnl, test.totalPnl);

    const degradation: DegradationResult = {
      profitFactor: pfDeg,
      sharpeRatio: sharpeDeg,
      totalPnl: pnlDeg,
    };

    const overfitFlags: string[] = [];
    if (pfDeg !== null && pfDeg > OVERFIT_THRESHOLD)
      overfitFlags.push('profitFactor');
    if (sharpeDeg !== null && sharpeDeg > OVERFIT_THRESHOLD)
      overfitFlags.push('sharpeRatio');
    if (pnlDeg !== null && pnlDeg > OVERFIT_THRESHOLD)
      overfitFlags.push('totalPnl');

    return { degradation, overfitFlags };
  }

  buildWalkForwardResults(
    trainPct: number,
    trainSteps: BacktestTimeStep[],
    testSteps: BacktestTimeStep[],
    trainMetrics: AggregateMetrics,
    testMetrics: AggregateMetrics,
  ): WalkForwardResults {
    const { degradation, overfitFlags } = this.compareMetrics(
      trainMetrics,
      testMetrics,
    );

    return {
      trainPct,
      testPct: Number(new Decimal(1).minus(trainPct).toFixed(2)),
      trainDateRange: {
        start: trainSteps[0]?.timestamp.toISOString() ?? '',
        end: trainSteps[trainSteps.length - 1]?.timestamp.toISOString() ?? '',
      },
      testDateRange: {
        start: testSteps[0]?.timestamp.toISOString() ?? '',
        end: testSteps[testSteps.length - 1]?.timestamp.toISOString() ?? '',
      },
      trainMetrics: this.serializeMetrics(trainMetrics),
      testMetrics: this.serializeMetrics(testMetrics),
      degradation,
      overfitFlags,
    };
  }

  private serializeMetrics(metrics: AggregateMetrics): SerializedMetrics {
    return {
      totalPositions: metrics.totalPositions,
      winCount: metrics.winCount,
      lossCount: metrics.lossCount,
      totalPnl: metrics.totalPnl.toFixed(REPORT_DECIMAL_PRECISION),
      maxDrawdown: metrics.maxDrawdown.toFixed(REPORT_DECIMAL_PRECISION),
      sharpeRatio:
        metrics.sharpeRatio?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      profitFactor:
        metrics.profitFactor?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      avgHoldingHours: metrics.avgHoldingHours.toFixed(
        REPORT_DECIMAL_PRECISION_SHORT,
      ),
      capitalUtilization: metrics.capitalUtilization.toFixed(
        REPORT_DECIMAL_PRECISION,
      ),
    };
  }

  private computeDegradation(
    trainVal: Decimal | null,
    testVal: Decimal | null,
  ): number | null {
    if (trainVal === null || testVal === null) return null;
    if (trainVal.isZero()) return null;
    // degradation = (train - test) / |train|
    // Use abs() to handle negative train values correctly (e.g., negative P&L)
    return trainVal.minus(testVal).div(trainVal.abs()).toNumber();
  }
}
