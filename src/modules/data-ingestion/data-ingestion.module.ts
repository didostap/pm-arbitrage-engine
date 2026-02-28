import { Module, forwardRef } from '@nestjs/common';
import { DataIngestionService } from './data-ingestion.service';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformHealthService } from './platform-health.service';
import { DegradationProtocolService } from './degradation-protocol.service';
import { PersistenceModule } from '../../common/persistence.module';
import { ConnectorModule } from '../../connectors/connector.module';
import { ContractMatchingModule } from '../contract-matching/contract-matching.module';

@Module({
  imports: [
    PersistenceModule,
    forwardRef(() => ConnectorModule),
    ContractMatchingModule,
  ],
  providers: [
    DegradationProtocolService,
    DataIngestionService,
    OrderBookNormalizerService,
    PlatformHealthService,
  ],
  exports: [
    DataIngestionService,
    PlatformHealthService,
    OrderBookNormalizerService,
    DegradationProtocolService,
  ],
})
export class DataIngestionModule {}
