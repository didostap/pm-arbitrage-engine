import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from '../../common/persistence.module.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { DailySummaryService } from './daily-summary.service.js';
import { TradeExportController } from './trade-export.controller.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { PositionRepository } from '../../persistence/repositories/position.repository.js';

@Module({
  imports: [ConfigModule, PersistenceModule],
  controllers: [TradeExportController],
  providers: [
    TelegramAlertService,
    EventConsumerService,
    CsvTradeLogService,
    DailySummaryService,
    OrderRepository,
    PositionRepository,
  ],
  exports: [TelegramAlertService, EventConsumerService, CsvTradeLogService],
})
export class MonitoringModule {}
