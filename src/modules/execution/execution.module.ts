import { Module } from '@nestjs/common';
import { ExecutionLockService } from './execution-lock.service';
import { ExecutionQueueService } from './execution-queue.service';
import { EXECUTION_QUEUE_TOKEN } from './execution.constants';
import { RiskManagementModule } from '../risk-management/risk-management.module';

@Module({
  imports: [RiskManagementModule],
  providers: [
    ExecutionLockService,
    {
      provide: EXECUTION_QUEUE_TOKEN,
      useClass: ExecutionQueueService,
    },
  ],
  exports: [ExecutionLockService, EXECUTION_QUEUE_TOKEN],
})
export class ExecutionModule {}
