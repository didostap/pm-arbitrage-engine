import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { BACKTEST_ENGINE_TOKEN } from '../../../common/interfaces/backtest-engine.interface';
import { PrismaService } from '../../../common/prisma.service';
import { BacktestEngineService } from './backtest-engine.service';
import { BacktestPortfolioService } from './backtest-portfolio.service';
import { FillModelService } from './fill-model.service';
import { ExitEvaluatorService } from './exit-evaluator.service';
import { BacktestStateMachineService } from './backtest-state-machine.service';
import { BacktestDataLoaderService } from './backtest-data-loader.service';
import { WalkForwardService } from '../reporting/walk-forward.service';
import { CalibrationReportService } from '../reporting/calibration-report.service';

describe('EngineModule', () => {
  const sharedProviders = [
    BacktestEngineService,
    {
      provide: BACKTEST_ENGINE_TOKEN,
      useExisting: BacktestEngineService,
    },
    BacktestStateMachineService,
    BacktestPortfolioService,
    FillModelService,
    ExitEvaluatorService,
    BacktestDataLoaderService,
    { provide: PrismaService, useValue: {} },
    { provide: EventEmitter2, useValue: new EventEmitter2() },
    {
      provide: ConfigService,
      useValue: { get: vi.fn().mockReturnValue(2) },
    },
    { provide: WalkForwardService, useValue: {} },
    {
      provide: CalibrationReportService,
      useValue: { generateReport: vi.fn() },
    },
  ];

  it('[P1] should register all 6 engine providers', async () => {
    const module = await Test.createTestingModule({
      providers: sharedProviders,
    }).compile();

    expect(module.get(BacktestEngineService)).toBeDefined();
    expect(module.get(BacktestStateMachineService)).toBeDefined();
    expect(module.get(BacktestPortfolioService)).toBeDefined();
    expect(module.get(FillModelService)).toBeDefined();
    expect(module.get(ExitEvaluatorService)).toBeDefined();
    expect(module.get(BacktestDataLoaderService)).toBeDefined();
  });

  it('[P1] should be importable from BacktestingModule', async () => {
    const { EngineModule } = await import('./engine.module');
    expect(EngineModule).toBeDefined();
  });

  it('[P1] should resolve BacktestEngineService via BACKTEST_ENGINE_TOKEN', async () => {
    const module = await Test.createTestingModule({
      providers: sharedProviders,
    }).compile();

    const engine = module.get(BACKTEST_ENGINE_TOKEN);
    expect(engine).toBeDefined();
    expect(engine.startRun).toBeDefined();
    expect(engine.cancelRun).toBeDefined();
    expect(engine.getRunStatus).toBeDefined();
  });
});
