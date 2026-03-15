import { Module, forwardRef } from '@nestjs/common';
import { DataIngestionService } from './data-ingestion.service';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformHealthService } from './platform-health.service';
import { DegradationProtocolService } from './degradation-protocol.service';
import { PriceFeedService } from './price-feed.service';
import { PersistenceModule } from '../../common/persistence.module';
import { ConnectorModule } from '../../connectors/connector.module';
import { ContractMatchingModule } from '../contract-matching/contract-matching.module';
import { PRICE_FEED_SERVICE_TOKEN } from '../../common/interfaces/price-feed-service.interface';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { DataDivergenceService } from './data-divergence.service';

@Module({
  imports: [
    PersistenceModule,
    forwardRef(() => ConnectorModule),
    ContractMatchingModule,
  ],
  providers: [
    DegradationProtocolService,
    DataIngestionService,
    DataDivergenceService,
    PositionRepository,
    OrderBookNormalizerService,
    PlatformHealthService,
    {
      provide: PRICE_FEED_SERVICE_TOKEN,
      useClass: PriceFeedService,
    },
  ],
  exports: [
    DataIngestionService,
    DataDivergenceService,
    PlatformHealthService,
    OrderBookNormalizerService,
    DegradationProtocolService,
    PRICE_FEED_SERVICE_TOKEN,
  ],
})
export class DataIngestionModule {}
