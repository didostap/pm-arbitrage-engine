import { Module } from '@nestjs/common';

import { ContractMatchSyncService } from './contract-match-sync.service.js';
import { ContractPairLoaderService } from './contract-pair-loader.service.js';
import { KnowledgeBaseService } from './knowledge-base.service.js';

@Module({
  providers: [
    ContractPairLoaderService,
    ContractMatchSyncService,
    KnowledgeBaseService,
  ],
  exports: [ContractPairLoaderService, KnowledgeBaseService],
})
export class ContractMatchingModule {}
