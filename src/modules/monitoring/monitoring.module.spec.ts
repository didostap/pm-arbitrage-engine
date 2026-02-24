import { describe, it, expect, beforeAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MonitoringModule } from './monitoring.module.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { DailySummaryService } from './daily-summary.service.js';
import { TradeExportController } from './trade-export.controller.js';
import { PersistenceModule } from '../../common/persistence.module.js';

describe('MonitoringModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        PersistenceModule,
        MonitoringModule,
      ],
    }).compile();
  });

  it('should compile and provide TelegramAlertService', () => {
    const service = module.get<TelegramAlertService>(TelegramAlertService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(TelegramAlertService);
  });

  it('should compile and provide EventConsumerService', () => {
    const service = module.get<EventConsumerService>(EventConsumerService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(EventConsumerService);
  });

  it('should compile and provide CsvTradeLogService', () => {
    const service = module.get<CsvTradeLogService>(CsvTradeLogService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(CsvTradeLogService);
  });

  it('should compile and provide DailySummaryService', () => {
    const service = module.get<DailySummaryService>(DailySummaryService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(DailySummaryService);
  });

  it('should compile and provide TradeExportController', () => {
    const controller = module.get<TradeExportController>(TradeExportController);
    expect(controller).toBeDefined();
    expect(controller).toBeInstanceOf(TradeExportController);
  });
});
