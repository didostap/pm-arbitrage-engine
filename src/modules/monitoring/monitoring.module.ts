import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from '../../common/persistence.module.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { TelegramCircuitBreakerService } from './telegram-circuit-breaker.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { DailySummaryService } from './daily-summary.service.js';
import { TradeExportController } from './trade-export.controller.js';
import { AuditLogService } from './audit-log.service.js';
import { AuditLogRetentionService } from './audit-log-retention.service.js';
import { AuditLogRepository } from '../../persistence/repositories/audit-log.repository.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { PositionRepository } from '../../persistence/repositories/position.repository.js';
import { MatchAprUpdaterService } from './match-apr-updater.service.js';
import { TimescaleStorageService } from './timescale-storage.service.js';
import { ConfigAccessor } from '../../common/config/config-accessor.service.js';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository.js';

@Module({
  imports: [ConfigModule, PersistenceModule],
  controllers: [TradeExportController],
  providers: [
    TelegramCircuitBreakerService,
    TelegramAlertService,
    EventConsumerService,
    CsvTradeLogService,
    DailySummaryService,
    AuditLogService,
    AuditLogRetentionService,
    AuditLogRepository,
    OrderRepository,
    PositionRepository,
    MatchAprUpdaterService,
    TimescaleStorageService,
    ConfigAccessor,
    EngineConfigRepository,
  ],
  exports: [
    TelegramAlertService,
    EventConsumerService,
    CsvTradeLogService,
    AuditLogService,
    TimescaleStorageService,
  ],
})
export class MonitoringModule {}
