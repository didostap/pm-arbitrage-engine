import { describe, it, expect, beforeAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MonitoringModule } from './monitoring.module.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { EventConsumerService } from './event-consumer.service.js';

describe('MonitoringModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
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
});
