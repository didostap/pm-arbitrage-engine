import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { DataQualityService } from './data-quality.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';

@Module({
  imports: [PersistenceModule],
  providers: [
    KalshiHistoricalService,
    PolymarketHistoricalService,
    DataQualityService,
    IngestionOrchestratorService,
  ],
  exports: [IngestionOrchestratorService],
})
export class IngestionModule {}
