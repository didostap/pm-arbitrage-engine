import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PersistenceModule } from './common/persistence.module';
import { ConnectorModule } from './connectors/connector.module';
import { CoreModule } from './core/core.module';
import { DataIngestionModule } from './modules/data-ingestion/data-ingestion.module';
import { ContractMatchingModule } from './modules/contract-matching/contract-matching.module';
import { loggerConfig } from './common/config/logger.config';

import { ArbitrageDetectionModule } from './modules/arbitrage-detection/arbitrage-detection.module';
import { ExitManagementModule } from './modules/exit-management/exit-management.module';

@Module({
  imports: [
    // CRITICAL: LoggerModule MUST be first to replace default logger early
    LoggerModule.forRoot(loggerConfig),

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20, // Increased from 10 for Phase 1 multi-module subscriptions
      verboseMemoryLeak: true,
    }),
    ScheduleModule.forRoot(), // For @Cron decorators in PlatformHealthService
    PersistenceModule,
    CoreModule,
    ConnectorModule,
    DataIngestionModule,
    ContractMatchingModule,
    ArbitrageDetectionModule,
    ExitManagementModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
