import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../common/persistence.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ValidationModule } from './validation/validation.module';
import { EngineModule } from './engine/engine.module';
import { HistoricalDataController } from './controllers/historical-data.controller';
import { BacktestController } from './controllers/backtest.controller';

@Module({
  imports: [PersistenceModule, IngestionModule, ValidationModule, EngineModule],
  controllers: [HistoricalDataController, BacktestController],
})
export class BacktestingModule {}
