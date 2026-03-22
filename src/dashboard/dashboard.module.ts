import { Module } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PositionEnrichmentService } from './position-enrichment.service';
import { MatchApprovalController } from './match-approval.controller';
import { MatchApprovalService } from './match-approval.service';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module';
import { ExecutionModule } from '../modules/execution/execution.module';
import { ExitManagementModule } from '../modules/exit-management/exit-management.module';
import { RiskManagementModule } from '../modules/risk-management/risk-management.module';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository';
import { PositionManagementController } from './position-management.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { MonitoringModule } from '../modules/monitoring/monitoring.module';
import { ConfigAccessor } from '../common/config/config-accessor.service';

@Module({
  imports: [
    DataIngestionModule,
    ExecutionModule,
    ExitManagementModule,
    RiskManagementModule,
    MonitoringModule,
  ],
  controllers: [
    DashboardController,
    MatchApprovalController,
    PerformanceController,
    PositionManagementController,
    SettingsController,
  ],
  providers: [
    DashboardGateway,
    DashboardEventMapperService,
    DashboardService,
    PositionEnrichmentService,
    MatchApprovalService,
    PerformanceService,
    PositionRepository,
    EngineConfigRepository,
    SettingsService,
    ConfigAccessor,
  ],
  exports: [ConfigAccessor],
})
export class DashboardModule {}
