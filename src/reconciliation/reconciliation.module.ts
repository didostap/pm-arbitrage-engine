import { Module } from '@nestjs/common';
import { ConnectorModule } from '../connectors/connector.module';
import { RiskManagementModule } from '../modules/risk-management/risk-management.module';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { StartupReconciliationService } from './startup-reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';

@Module({
  imports: [ConnectorModule, RiskManagementModule],
  providers: [
    StartupReconciliationService,
    PositionRepository,
    OrderRepository,
  ],
  controllers: [ReconciliationController],
  exports: [StartupReconciliationService],
})
export class ReconciliationModule {}
