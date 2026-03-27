import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { BACKTEST_ENGINE_TOKEN } from '../../../common/interfaces/backtest-engine.interface';
import { BacktestEngineService } from './backtest-engine.service';
import { BacktestStateMachineService } from './backtest-state-machine.service';
import { BacktestPortfolioService } from './backtest-portfolio.service';
import { FillModelService } from './fill-model.service';
import { ExitEvaluatorService } from './exit-evaluator.service';

@Module({
  imports: [PersistenceModule],
  providers: [
    BacktestEngineService,
    {
      provide: BACKTEST_ENGINE_TOKEN,
      useExisting: BacktestEngineService,
    },
    BacktestStateMachineService,
    BacktestPortfolioService,
    FillModelService,
    ExitEvaluatorService,
  ],
  exports: [
    BACKTEST_ENGINE_TOKEN,
    BacktestEngineService,
    BacktestStateMachineService,
    BacktestPortfolioService,
    FillModelService,
    ExitEvaluatorService,
  ],
})
export class EngineModule {}
