import { Module } from '@nestjs/common';
import { ConnectorModule } from '../../connectors/connector.module';
import { RiskManagementModule } from '../risk-management/risk-management.module';
import { ExitMonitorService } from './exit-monitor.service';
import { ThresholdEvaluatorService } from './threshold-evaluator.service';
import { ShadowComparisonService } from './shadow-comparison.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';

@Module({
  imports: [ConnectorModule, RiskManagementModule],
  providers: [
    ExitMonitorService,
    ThresholdEvaluatorService,
    ShadowComparisonService,
    PositionRepository,
    OrderRepository,
  ],
  exports: [ExitMonitorService, ShadowComparisonService],
})
export class ExitManagementModule {}
