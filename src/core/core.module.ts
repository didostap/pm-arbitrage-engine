import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EngineLifecycleService } from './engine-lifecycle.service';
import { TradingEngineService } from './trading-engine.service';
import { SchedulerService } from './scheduler.service';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module';

/**
 * Core module providing engine lifecycle management and orchestration.
 * Includes scheduler, trading engine, and lifecycle hooks.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(), // Required for scheduler functionality
    DataIngestionModule, // Provides DataIngestionService for TradingEngineService
  ],
  providers: [EngineLifecycleService, TradingEngineService, SchedulerService],
  exports: [TradingEngineService], // Export for future monitoring integration
})
export class CoreModule {}
