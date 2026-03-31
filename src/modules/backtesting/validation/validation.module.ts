import { Module, forwardRef } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { PREDEXON_PAIR_PROVIDER_TOKEN } from '../../../common/interfaces/external-pair-provider.interface';
import { IngestionModule } from '../ingestion/ingestion.module';
import { PredexonMatchingService } from './predexon-matching.service';
import { MatchValidationService } from './match-validation.service';
import { MatchValidationController } from '../controllers/match-validation.controller';

@Module({
  imports: [PersistenceModule, forwardRef(() => IngestionModule)],
  providers: [
    PredexonMatchingService,
    MatchValidationService,
    {
      provide: PREDEXON_PAIR_PROVIDER_TOKEN,
      useExisting: PredexonMatchingService,
    },
  ],
  controllers: [MatchValidationController],
  exports: [MatchValidationService, PREDEXON_PAIR_PROVIDER_TOKEN],
})
export class ValidationModule {}
