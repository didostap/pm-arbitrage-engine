import { Module, forwardRef } from '@nestjs/common';

import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface.js';
import { CLUSTER_CLASSIFIER_TOKEN } from '../../common/interfaces/cluster-classifier.interface.js';
import { ClusterClassifierService } from './cluster-classifier.service.js';
import { MonitoringModule } from '../monitoring/monitoring.module.js';
import { ContractMatchSyncService } from './contract-match-sync.service.js';
import { ContractPairLoaderService } from './contract-pair-loader.service.js';
import { KnowledgeBaseService } from './knowledge-base.service.js';
import { PreFilterService } from './pre-filter.service.js';
import { LlmScoringStrategy } from './llm-scoring.strategy.js';
import { ConfidenceScorerService } from './confidence-scorer.service.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import { CandidateDiscoveryService } from './candidate-discovery.service.js';
import { ResolutionPollerService } from './resolution-poller.service.js';
import { CalibrationService } from './calibration.service.js';
import { CalibrationController } from './calibration.controller.js';
import { ConnectorModule } from '../../connectors/connector.module.js';

export { SCORING_STRATEGY_TOKEN };

@Module({
  imports: [forwardRef(() => ConnectorModule), MonitoringModule],
  controllers: [CalibrationController],
  providers: [
    ContractPairLoaderService,
    ContractMatchSyncService,
    KnowledgeBaseService,
    PreFilterService,
    LlmScoringStrategy,
    { provide: SCORING_STRATEGY_TOKEN, useExisting: LlmScoringStrategy },
    ClusterClassifierService,
    {
      provide: CLUSTER_CLASSIFIER_TOKEN,
      useExisting: ClusterClassifierService,
    },
    ConfidenceScorerService,
    CatalogSyncService,
    CandidateDiscoveryService,
    ResolutionPollerService,
    CalibrationService,
  ],
  exports: [
    ContractPairLoaderService,
    KnowledgeBaseService,
    ConfidenceScorerService,
    PreFilterService,
    CLUSTER_CLASSIFIER_TOKEN,
  ],
})
export class ContractMatchingModule {}
