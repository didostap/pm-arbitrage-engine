import { Module } from '@nestjs/common';

import { ContractPairLoaderService } from './contract-pair-loader.service.js';

@Module({
  providers: [ContractPairLoaderService],
  exports: [ContractPairLoaderService],
})
export class ContractMatchingModule {}
