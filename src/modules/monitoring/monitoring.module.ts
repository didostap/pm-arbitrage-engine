import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramAlertService } from './telegram-alert.service.js';
import { EventConsumerService } from './event-consumer.service.js';

@Module({
  imports: [ConfigModule],
  providers: [TelegramAlertService, EventConsumerService],
  exports: [TelegramAlertService, EventConsumerService],
})
export class MonitoringModule {}
