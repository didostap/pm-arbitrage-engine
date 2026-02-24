import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramAlertService } from './telegram-alert.service.js';

@Module({
  imports: [ConfigModule],
  providers: [TelegramAlertService],
  exports: [TelegramAlertService],
})
export class MonitoringModule {}
