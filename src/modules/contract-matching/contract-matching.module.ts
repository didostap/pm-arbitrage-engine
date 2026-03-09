import { Module } from '@nestjs/common';

import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface.js';
import { ContractMatchSyncService } from './contract-match-sync.service.js';
import { ContractPairLoaderService } from './contract-pair-loader.service.js';
import { KnowledgeBaseService } from './knowledge-base.service.js';
import { PreFilterService } from './pre-filter.service.js';
import { LlmScoringStrategy } from './llm-scoring.strategy.js';
import { ConfidenceScorerService } from './confidence-scorer.service.js';

export { SCORING_STRATEGY_TOKEN };

@Module({
  providers: [
    ContractPairLoaderService,
    ContractMatchSyncService,
    KnowledgeBaseService,
    PreFilterService,
    LlmScoringStrategy,
    { provide: SCORING_STRATEGY_TOKEN, useExisting: LlmScoringStrategy },
    ConfidenceScorerService,
  ],
  exports: [
    ContractPairLoaderService,
    KnowledgeBaseService,
    ConfidenceScorerService,
    PreFilterService,
  ],
})
export class ContractMatchingModule {}
