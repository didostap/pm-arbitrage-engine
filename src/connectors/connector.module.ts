import { Module } from '@nestjs/common';
import { KalshiConnector } from './kalshi/kalshi.connector.js';
import { PolymarketConnector } from './polymarket/polymarket.connector.js';

@Module({
  providers: [KalshiConnector, PolymarketConnector],
  exports: [KalshiConnector, PolymarketConnector],
})
export class ConnectorModule {}
