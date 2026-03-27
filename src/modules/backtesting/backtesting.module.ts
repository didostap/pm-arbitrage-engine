import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../common/persistence.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ValidationModule } from './validation/validation.module';
import { HistoricalDataController } from './controllers/historical-data.controller';

@Module({
  imports: [PersistenceModule, IngestionModule, ValidationModule],
  controllers: [HistoricalDataController],
})
export class BacktestingModule {}
