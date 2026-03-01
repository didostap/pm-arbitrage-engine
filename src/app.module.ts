import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SystemErrorFilter } from './common/filters/system-error.filter';

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
      maxListeners: 25, // Increased for Phase 1 multi-module subscriptions + dashboard gateway
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
    ReconciliationModule,
    MonitoringModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_FILTER, useClass: SystemErrorFilter }],
})
export class AppModule {}
