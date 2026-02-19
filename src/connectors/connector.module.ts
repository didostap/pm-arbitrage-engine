import { Module, forwardRef } from '@nestjs/common';
import { KalshiConnector } from './kalshi/kalshi.connector.js';
import { PolymarketConnector } from './polymarket/polymarket.connector.js';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from './connector.constants.js';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module.js';

@Module({
  imports: [forwardRef(() => DataIngestionModule)],
  providers: [
    KalshiConnector,
    PolymarketConnector,
    { provide: KALSHI_CONNECTOR_TOKEN, useExisting: KalshiConnector },
    { provide: POLYMARKET_CONNECTOR_TOKEN, useExisting: PolymarketConnector },
  ],
  exports: [
    KalshiConnector,
    PolymarketConnector,
    KALSHI_CONNECTOR_TOKEN,
    POLYMARKET_CONNECTOR_TOKEN,
  ],
})
export class ConnectorModule {}
