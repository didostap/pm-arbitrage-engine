import { Module, forwardRef } from '@nestjs/common';
import { KalshiConnector } from './kalshi/kalshi.connector.js';
import { PolymarketConnector } from './polymarket/polymarket.connector.js';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module.js';

@Module({
  imports: [forwardRef(() => DataIngestionModule)],
  providers: [KalshiConnector, PolymarketConnector],
  exports: [KalshiConnector, PolymarketConnector],
})
export class ConnectorModule {}
