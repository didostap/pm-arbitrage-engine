import { Module } from '@nestjs/common';
import { ExecutionLockService } from './execution-lock.service';
import { ExecutionQueueService } from './execution-queue.service';
import { ExecutionService } from './execution.service';
import {
  EXECUTION_QUEUE_TOKEN,
  EXECUTION_ENGINE_TOKEN,
} from './execution.constants';
import { RiskManagementModule } from '../risk-management/risk-management.module';
import { ConnectorModule } from '../../connectors/connector.module';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { PrismaService } from '../../common/prisma.service';
import { ExposureTrackerService } from './exposure-tracker.service';

@Module({
  imports: [RiskManagementModule, ConnectorModule],
  providers: [
    ExecutionLockService,
    PrismaService,
    OrderRepository,
    PositionRepository,
    ExposureTrackerService,
    {
      provide: EXECUTION_ENGINE_TOKEN,
      useClass: ExecutionService,
    },
    {
      provide: EXECUTION_QUEUE_TOKEN,
      useClass: ExecutionQueueService,
    },
  ],
  exports: [
    ExecutionLockService,
    EXECUTION_QUEUE_TOKEN,
    EXECUTION_ENGINE_TOKEN,
  ],
})
export class ExecutionModule {}
