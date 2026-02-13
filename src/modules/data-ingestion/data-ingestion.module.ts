import { Module } from '@nestjs/common';
import { DataIngestionService } from './data-ingestion.service';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformHealthService } from './platform-health.service';
import { PersistenceModule } from '../../common/persistence.module';
import { ConnectorModule } from '../../connectors/connector.module';

@Module({
  imports: [PersistenceModule, ConnectorModule],
  providers: [
    DataIngestionService,
    OrderBookNormalizerService,
    PlatformHealthService,
  ],
  exports: [DataIngestionService, PlatformHealthService],
})
export class DataIngestionModule {}
