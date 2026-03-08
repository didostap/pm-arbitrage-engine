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
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { SingleLegResolutionController } from './single-leg-resolution.controller';
import { ExposureAlertScheduler } from './exposure-alert-scheduler.service';
import { ComplianceConfigLoaderService } from './compliance/compliance-config-loader.service';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
import { PositionCloseService } from './position-close.service';
import { POSITION_CLOSE_SERVICE_TOKEN } from '../../common/interfaces/position-close-service.interface';

@Module({
  imports: [RiskManagementModule, ConnectorModule],
  controllers: [SingleLegResolutionController],
  providers: [
    ExecutionLockService,
    PrismaService,
    OrderRepository,
    PositionRepository,
    ExposureTrackerService,
    SingleLegResolutionService,
    ExposureAlertScheduler,
    ComplianceConfigLoaderService,
    ComplianceValidatorService,
    {
      provide: EXECUTION_ENGINE_TOKEN,
      useClass: ExecutionService,
    },
    {
      provide: EXECUTION_QUEUE_TOKEN,
      useClass: ExecutionQueueService,
    },
    {
      provide: POSITION_CLOSE_SERVICE_TOKEN,
      useClass: PositionCloseService,
    },
  ],
  exports: [
    ExecutionLockService,
    EXECUTION_QUEUE_TOKEN,
    EXECUTION_ENGINE_TOKEN,
    ComplianceConfigLoaderService,
    POSITION_CLOSE_SERVICE_TOKEN,
  ],
})
export class ExecutionModule {}
