import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EngineLifecycleService } from './engine-lifecycle.service';
import { TradingEngineService } from './trading-engine.service';
import { SchedulerService } from './scheduler.service';

/**
 * Core module providing engine lifecycle management and orchestration.
 * Includes scheduler, trading engine, and lifecycle hooks.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(), // Required for scheduler functionality
  ],
  providers: [EngineLifecycleService, TradingEngineService, SchedulerService],
  exports: [TradingEngineService], // Export for future monitoring integration
})
export class CoreModule {}
