import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { PmxtArchiveService } from './pmxt-archive.service';
import { OddsPipeService } from './oddspipe.service';
import { DataQualityService } from './data-quality.service';
import { IngestionQualityAssessorService } from './ingestion-quality-assessor.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';

@Module({
  imports: [PersistenceModule],
  providers: [
    KalshiHistoricalService,
    PolymarketHistoricalService,
    PmxtArchiveService,
    OddsPipeService,
    DataQualityService,
    IngestionQualityAssessorService,
    IngestionOrchestratorService,
  ],
  exports: [IngestionOrchestratorService, OddsPipeService],
})
export class IngestionModule {}
