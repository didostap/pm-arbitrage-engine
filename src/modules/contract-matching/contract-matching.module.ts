import { Module } from '@nestjs/common';

import { ContractMatchSyncService } from './contract-match-sync.service.js';
import { ContractPairLoaderService } from './contract-pair-loader.service.js';

@Module({
  providers: [ContractPairLoaderService, ContractMatchSyncService],
  exports: [ContractPairLoaderService],
})
export class ContractMatchingModule {}
