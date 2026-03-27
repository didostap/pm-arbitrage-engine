import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { PredexonMatchingService } from './predexon-matching.service';
import { MatchValidationService } from './match-validation.service';
import { MatchValidationController } from '../controllers/match-validation.controller';

@Module({
  imports: [PersistenceModule, IngestionModule],
  providers: [PredexonMatchingService, MatchValidationService],
  controllers: [MatchValidationController],
})
export class ValidationModule {}
