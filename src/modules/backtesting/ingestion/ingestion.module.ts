import { Module, forwardRef } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { ODDSPIPE_PAIR_PROVIDER_TOKEN } from '../../../common/interfaces/external-pair-provider.interface';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { PmxtArchiveService } from './pmxt-archive.service';
import { OddsPipeService } from './oddspipe.service';
import { DataQualityService } from './data-quality.service';
import { IngestionQualityAssessorService } from './ingestion-quality-assessor.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { IncrementalIngestionService } from './incremental-ingestion.service';
import { IncrementalFetchService } from './incremental-fetch.service';
import { ValidationModule } from '../validation/validation.module';

@Module({
  imports: [PersistenceModule, forwardRef(() => ValidationModule)],
  providers: [
    KalshiHistoricalService,
    PolymarketHistoricalService,
    PmxtArchiveService,
    OddsPipeService,
    DataQualityService,
    IngestionQualityAssessorService,
    IngestionOrchestratorService,
    IncrementalIngestionService,
    IncrementalFetchService,
    { provide: ODDSPIPE_PAIR_PROVIDER_TOKEN, useExisting: OddsPipeService },
  ],
  exports: [
    IngestionOrchestratorService,
    OddsPipeService,
    ODDSPIPE_PAIR_PROVIDER_TOKEN,
  ],
})
export class IngestionModule {}
