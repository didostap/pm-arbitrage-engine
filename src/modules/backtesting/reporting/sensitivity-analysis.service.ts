import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  BacktestSensitivityCompletedEvent,
  BacktestSensitivityProgressEvent,
} from '../../../common/events/backtesting.events';
import { REPORT_DECIMAL_PRECISION } from '../types/calibration-report.types';
import type {
  SensitivityResults,
  ParameterSweep,
  DegradationBoundary,
  RecommendedParameters,
  SweepConfig,
} from '../types/calibration-report.types';
import type { IBacktestConfig } from '../../../common/interfaces/backtest-engine.interface';
import { BacktestEngineService } from '../engine/backtest-engine.service';

const MAX_SWEEP_POINTS = 500;
const PROGRESS_INTERVAL = 10;

const DEFAULT_TRADING_WINDOW_VARIANTS = [
  { startHour: 0, endHour: 24, label: 'full-day' },
  { startHour: 14, endHour: 21, label: 'us-afternoon' },
  { startHour: 8, endHour: 16, label: 'eu-business' },
  { startHour: 21, endHour: 4, label: 'overnight-us' },
  { startHour: 14, endHour: 23, label: 'default' },
];

@Injectable()
export class SensitivityAnalysisService {
  /** Cleanup: .delete(runId) in finally block of runSweep. Bounded by concurrent runs. */
  private readonly inProgress = new Map<string, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(BacktestEngineService)
    private readonly engineService: BacktestEngineService,
  ) {}

  isInProgress(runId: string): boolean {
    return this.inProgress.has(runId);
  }

  async runSweep(
    runId: string,
    sweepConfig?: SweepConfig,
  ): Promise<SensitivityResults> {
    // Concurrency guard
    if (this.inProgress.has(runId)) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `Sensitivity sweep already in progress for run ${runId}`,
        'error',
        'sensitivity-analysis',
      );
    }

    this.inProgress.set(runId, true);
    try {
      return await this.executeSweep(runId, sweepConfig);
    } finally {
      this.inProgress.delete(runId);
    }
  }

  private async executeSweep(
    runId: string,
    sweepConfig?: SweepConfig,
  ): Promise<SensitivityResults> {
    // Validate sweep config
    if (sweepConfig) this.validateSweepConfig(sweepConfig);

    const run = await this.prisma.backtestRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} not found`,
        'error',
        'sensitivity-analysis',
      );
    }
    if (run.status !== 'COMPLETE') {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} has status ${run.status}, expected COMPLETE`,
        'error',
        'sensitivity-analysis',
      );
    }

    if (!run.config || typeof run.config !== 'object') {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} has invalid or missing config`,
        'error',
        'sensitivity-analysis',
      );
    }
    const baseConfig = run.config as unknown as IBacktestConfig;
    if (
      baseConfig.edgeThresholdPct === undefined ||
      baseConfig.bankrollUsd === undefined ||
      baseConfig.positionSizePct === undefined ||
      baseConfig.maxConcurrentPairs === undefined
    ) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} config missing required fields`,
        'error',
        'sensitivity-analysis',
      );
    }

    // Load data ONCE and reuse across all sweeps
    const pairs = await this.engineService.loadPairs(baseConfig);
    const prices = await this.engineService.loadPrices(baseConfig);
    const timeSteps = this.engineService.alignPrices(prices, pairs);

    // Build sweep ranges
    const edgeRange = sweepConfig?.edgeThresholdRange ?? {
      min: 0.005,
      max: 0.05,
      step: 0.001,
    };
    const posRange = sweepConfig?.positionSizeRange ?? {
      min: 0.01,
      max: 0.05,
      step: 0.005,
    };
    const pairsRange = sweepConfig?.maxConcurrentPairsRange ?? {
      min: 5,
      max: 30,
      step: 5,
    };
    const windowVariants =
      sweepConfig?.tradingWindowVariants ?? DEFAULT_TRADING_WINDOW_VARIANTS;
    const timeoutMs = (sweepConfig?.timeoutSeconds ?? 1800) * 1000;

    const edgeValues = this.generateRange(
      edgeRange.min,
      edgeRange.max,
      edgeRange.step,
    );
    const posValues = this.generateRange(
      posRange.min,
      posRange.max,
      posRange.step,
    );
    const pairsValues = this.generateRange(
      pairsRange.min,
      pairsRange.max,
      pairsRange.step,
    );

    const totalPlannedSweeps =
      edgeValues.length +
      posValues.length +
      pairsValues.length +
      windowVariants.length;
    const startTime = Date.now();
    const sweeps: ParameterSweep[] = [];
    let completedSweeps = 0;
    let partial = false;

    const emitProgress = (completed: number) => {
      if (completed > 0 && completed % PROGRESS_INTERVAL === 0) {
        this.eventEmitter.emit(
          EVENT_NAMES.BACKTEST_SENSITIVITY_PROGRESS,
          new BacktestSensitivityProgressEvent({
            runId,
            completedSweeps: completed,
            totalPlannedSweeps,
          }),
        );
      }
    };

    // Edge threshold sweep
    const edgeSweep = await this.runDimensionSweep(
      'edgeThresholdPct',
      baseConfig.edgeThresholdPct,
      edgeValues,
      (val) => ({ ...baseConfig, edgeThresholdPct: val }),
      timeSteps,
      startTime,
      timeoutMs,
    );
    if (edgeSweep.timedOut) partial = true;
    sweeps.push(edgeSweep.sweep);
    completedSweeps += edgeSweep.completedPoints;
    emitProgress(completedSweeps);

    // Position size sweep
    if (!partial) {
      const posSweep = await this.runDimensionSweep(
        'positionSizePct',
        baseConfig.positionSizePct,
        posValues,
        (val) => ({ ...baseConfig, positionSizePct: val }),
        timeSteps,
        startTime,
        timeoutMs,
      );
      if (posSweep.timedOut) partial = true;
      sweeps.push(posSweep.sweep);
      completedSweeps += posSweep.completedPoints;
      emitProgress(completedSweeps);
    }

    // Max concurrent pairs sweep
    if (!partial) {
      const pairsSweep = await this.runDimensionSweep(
        'maxConcurrentPairs',
        baseConfig.maxConcurrentPairs,
        pairsValues,
        (val) => ({ ...baseConfig, maxConcurrentPairs: Math.round(val) }),
        timeSteps,
        startTime,
        timeoutMs,
      );
      if (pairsSweep.timedOut) partial = true;
      sweeps.push(pairsSweep.sweep);
      completedSweeps += pairsSweep.completedPoints;
      emitProgress(completedSweeps);
    }

    // Trading window sweep
    if (!partial) {
      const twSweep = await this.runTradingWindowSweep(
        baseConfig,
        windowVariants,
        timeSteps,
        startTime,
        timeoutMs,
      );
      if (twSweep.timedOut) partial = true;
      sweeps.push(twSweep.sweep);
      completedSweeps += twSweep.completedPoints;
      emitProgress(completedSweeps);
    }

    const degradationBoundaries = this.findAllDegradationBoundaries(sweeps);
    const recommendedParameters = this.findRecommendedParameters(sweeps);

    const result: SensitivityResults = {
      sweeps,
      degradationBoundaries,
      recommendedParameters,
      partial,
      completedSweeps,
      totalPlannedSweeps,
    };

    await this.prisma.backtestRun.update({
      where: { id: runId },
      data: { sensitivityResults: result as any },
    });

    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_SENSITIVITY_COMPLETED,
      new BacktestSensitivityCompletedEvent({
        runId,
        sweepCount: completedSweeps,
        recommendedParams: recommendedParameters as any,
      }),
    );

    return result;
  }

  private async runDimensionSweep(
    paramName: string,
    baseValue: number,
    values: number[],
    configFactory: (val: number) => IBacktestConfig,
    timeSteps: any[],
    startTime: number,
    timeoutMs: number,
  ): Promise<{
    sweep: ParameterSweep;
    completedPoints: number;
    timedOut: boolean;
  }> {
    const profitFactors: (string | null)[] = [];
    const maxDrawdowns: string[] = [];
    const sharpeRatios: (string | null)[] = [];
    const totalPnls: string[] = [];
    let timedOut = false;
    let completedPoints = 0;

    for (const val of values) {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        break;
      }

      const config = configFactory(val);
      const metrics = await this.engineService.runHeadlessSimulation(
        config,
        timeSteps,
      );
      profitFactors.push(
        metrics.profitFactor?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      );
      maxDrawdowns.push(metrics.maxDrawdown.toFixed(REPORT_DECIMAL_PRECISION));
      sharpeRatios.push(
        metrics.sharpeRatio?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      );
      totalPnls.push(metrics.totalPnl.toFixed(REPORT_DECIMAL_PRECISION));
      completedPoints++;
    }

    return {
      sweep: {
        parameterName: paramName,
        baseValue,
        values: values.slice(0, completedPoints),
        profitFactor: profitFactors,
        maxDrawdown: maxDrawdowns,
        sharpeRatio: sharpeRatios,
        totalPnl: totalPnls,
      },
      completedPoints,
      timedOut,
    };
  }

  private async runTradingWindowSweep(
    baseConfig: IBacktestConfig,
    variants: { startHour: number; endHour: number; label: string }[],
    timeSteps: any[],
    startTime: number,
    timeoutMs: number,
  ): Promise<{
    sweep: ParameterSweep;
    completedPoints: number;
    timedOut: boolean;
  }> {
    const profitFactors: (string | null)[] = [];
    const maxDrawdowns: string[] = [];
    const sharpeRatios: (string | null)[] = [];
    const totalPnls: string[] = [];
    const values: number[] = [];
    let timedOut = false;
    let completedPoints = 0;

    for (let i = 0; i < variants.length; i++) {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        break;
      }

      const variant = variants[i]!;
      const config: IBacktestConfig = {
        ...baseConfig,
        tradingWindowStartHour: variant.startHour,
        tradingWindowEndHour: variant.endHour,
      };

      const metrics = await this.engineService.runHeadlessSimulation(
        config,
        timeSteps,
      );
      profitFactors.push(
        metrics.profitFactor?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      );
      maxDrawdowns.push(metrics.maxDrawdown.toFixed(REPORT_DECIMAL_PRECISION));
      sharpeRatios.push(
        metrics.sharpeRatio?.toFixed(REPORT_DECIMAL_PRECISION) ?? null,
      );
      totalPnls.push(metrics.totalPnl.toFixed(REPORT_DECIMAL_PRECISION));
      values.push(i);
      completedPoints++;
    }

    return {
      sweep: {
        parameterName: 'tradingWindow',
        baseValue: 0,
        values,
        profitFactor: profitFactors,
        maxDrawdown: maxDrawdowns,
        sharpeRatio: sharpeRatios,
        totalPnl: totalPnls,
      },
      completedPoints,
      timedOut,
    };
  }

  private findAllDegradationBoundaries(
    sweeps: ParameterSweep[],
  ): DegradationBoundary[] {
    return sweeps.map((sweep) => {
      const boundary = this.findBreakEvenValue(
        sweep.values,
        sweep.profitFactor.map((pf) => (pf !== null ? new Decimal(pf) : null)),
      );

      if (boundary === null) {
        return {
          parameterName: sweep.parameterName,
          breakEvenValue: null,
          direction: 'above' as const,
          description: `Profit factor never crosses 1.0 within sweep range`,
        };
      }

      const desc =
        boundary.direction === 'above'
          ? `Above ${boundary.value.toFixed(4)}, profit factor drops below 1.0`
          : `Below ${boundary.value.toFixed(4)}, profit factor drops below 1.0`;

      return {
        parameterName: sweep.parameterName,
        breakEvenValue: boundary.value,
        direction: boundary.direction,
        description: desc,
      };
    });
  }

  private findBreakEvenValue(
    values: number[],
    profitFactors: (Decimal | null)[],
  ): { value: number; direction: 'below' | 'above' } | null {
    for (let i = 1; i < values.length; i++) {
      const prev = profitFactors[i - 1];
      const curr = profitFactors[i];
      if (!prev || !curr) continue;

      // Downward crossing: profitable → unprofitable as value increases
      if (prev.gte(1) && curr.lt(1)) {
        return {
          value: this.interpolateBreakEven(values, prev, curr, i),
          direction: 'above',
        };
      }
      // Upward crossing: unprofitable → profitable as value increases
      if (prev.lt(1) && curr.gte(1)) {
        return {
          value: this.interpolateBreakEven(values, prev, curr, i),
          direction: 'below',
        };
      }
    }
    return null;
  }

  private interpolateBreakEven(
    values: number[],
    prev: Decimal,
    curr: Decimal,
    i: number,
  ): number {
    const slope = curr
      .minus(prev)
      .div(new Decimal(values[i]! - values[i - 1]!));
    if (slope.isZero()) return values[i]!;
    return new Decimal(1)
      .minus(prev)
      .div(slope)
      .plus(values[i - 1]!)
      .toNumber();
  }

  private findRecommendedParameters(
    sweeps: ParameterSweep[],
  ): RecommendedParameters {
    const byProfitFactor: {
      parameterName: string;
      value: number;
      profitFactor: string;
    }[] = [];
    const bySharpe: {
      parameterName: string;
      value: number;
      sharpeRatio: string;
    }[] = [];

    for (const sweep of sweeps) {
      let bestPfIdx = -1;
      let bestPf: Decimal | null = null;
      let bestSharpeIdx = -1;
      let bestSharpe: Decimal | null = null;

      for (let i = 0; i < sweep.values.length; i++) {
        const pf = sweep.profitFactor[i]
          ? new Decimal(sweep.profitFactor[i]!)
          : null;
        const sr = sweep.sharpeRatio[i]
          ? new Decimal(sweep.sharpeRatio[i]!)
          : null;

        if (pf !== null && (bestPf === null || pf.gt(bestPf))) {
          bestPf = pf;
          bestPfIdx = i;
        }
        if (sr !== null && (bestSharpe === null || sr.gt(bestSharpe))) {
          bestSharpe = sr;
          bestSharpeIdx = i;
        }
      }

      if (bestPfIdx >= 0 && bestPf !== null) {
        byProfitFactor.push({
          parameterName: sweep.parameterName,
          value: sweep.values[bestPfIdx]!,
          profitFactor: bestPf.toFixed(REPORT_DECIMAL_PRECISION),
        });
      }
      if (bestSharpeIdx >= 0 && bestSharpe !== null) {
        bySharpe.push({
          parameterName: sweep.parameterName,
          value: sweep.values[bestSharpeIdx]!,
          sharpeRatio: bestSharpe.toFixed(REPORT_DECIMAL_PRECISION),
        });
      }
    }

    return { byProfitFactor, bySharpe };
  }

  private validateSweepConfig(config: SweepConfig): void {
    const pctRanges = [
      { name: 'edgeThresholdRange', range: config.edgeThresholdRange },
      { name: 'positionSizeRange', range: config.positionSizeRange },
    ];

    for (const { name, range } of pctRanges) {
      if (!range) continue;
      if (range.min < 0) this.throwValidation(`${name}: min must be >= 0`);
      if (range.max > 1) this.throwValidation(`${name}: max must be <= 1.0`);
      if (range.min >= range.max)
        this.throwValidation(`${name}: min must be < max`);
      if (range.step <= 0) this.throwValidation(`${name}: step must be > 0`);
    }

    if (config.maxConcurrentPairsRange) {
      const r = config.maxConcurrentPairsRange;
      if (r.min < 0)
        this.throwValidation('maxConcurrentPairsRange: min must be >= 0');
      if (r.max > 100)
        this.throwValidation('maxConcurrentPairsRange: max must be <= 100');
      if (r.min >= r.max)
        this.throwValidation('maxConcurrentPairsRange: min must be < max');
      if (r.step <= 0)
        this.throwValidation('maxConcurrentPairsRange: step must be > 0');
    }

    if (config.timeoutSeconds !== undefined) {
      if (config.timeoutSeconds <= 0 || config.timeoutSeconds > 7200) {
        this.throwValidation('timeoutSeconds must be > 0 and <= 7200');
      }
    }
  }

  private throwValidation(message: string): never {
    throw new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
      `Invalid SweepConfig: ${message}`,
      'error',
      'sensitivity-analysis',
    );
  }

  private generateRange(min: number, max: number, step: number): number[] {
    const values: number[] = [];
    let v = new Decimal(min);
    const maxDec = new Decimal(max);
    const stepDec = new Decimal(step);
    while (v.lte(maxDec)) {
      values.push(v.toNumber());
      if (values.length >= MAX_SWEEP_POINTS) {
        this.throwValidation(
          `Sweep range produces ${values.length}+ points (max ${MAX_SWEEP_POINTS}). Use a larger step.`,
        );
      }
      v = v.plus(stepDec);
    }
    return values;
  }
}
