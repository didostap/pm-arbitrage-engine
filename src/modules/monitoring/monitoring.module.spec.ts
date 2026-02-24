import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MonitoringModule } from './monitoring.module.js';
import { TelegramAlertService } from './telegram-alert.service.js';

describe('MonitoringModule', () => {
  it('should compile and provide TelegramAlertService', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        EventEmitterModule.forRoot(),
        MonitoringModule,
      ],
    }).compile();

    const service = module.get<TelegramAlertService>(TelegramAlertService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(TelegramAlertService);
  });
});
