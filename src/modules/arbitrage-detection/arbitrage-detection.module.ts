import { Module } from '@nestjs/common';
import { ContractMatchingModule } from '../contract-matching/contract-matching.module';
import { DataIngestionModule } from '../data-ingestion/data-ingestion.module';
import { ConnectorModule } from '../../connectors/connector.module';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository';
import { ConfigAccessor } from '../../common/config/config-accessor.service';
import { DetectionService } from './detection.service';
import { EdgeCalculatorService } from './edge-calculator.service';
import { PairConcentrationFilterService } from './pair-concentration-filter.service';
import { PAIR_CONCENTRATION_FILTER_TOKEN } from '../../common/interfaces';

@Module({
  imports: [ContractMatchingModule, DataIngestionModule, ConnectorModule],
  providers: [
    DetectionService,
    EdgeCalculatorService,
    PositionRepository,
    EngineConfigRepository,
    ConfigAccessor,
    {
      provide: PAIR_CONCENTRATION_FILTER_TOKEN,
      useClass: PairConcentrationFilterService,
    },
  ],
  exports: [
    DetectionService,
    EdgeCalculatorService,
    PAIR_CONCENTRATION_FILTER_TOKEN,
  ],
})
export class ArbitrageDetectionModule {}
