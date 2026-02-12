import { Module } from '@nestjs/common';
import { KalshiConnector } from './kalshi/kalshi.connector.js';

@Module({
  providers: [KalshiConnector],
  exports: [KalshiConnector],
})
export class ConnectorModule {}
