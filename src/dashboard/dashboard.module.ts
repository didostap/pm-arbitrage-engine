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
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module';

@Module({
  imports: [DataIngestionModule],
  controllers: [
    DashboardController,
    MatchApprovalController,
    PerformanceController,
  ],
  providers: [
    DashboardGateway,
    DashboardEventMapperService,
    DashboardService,
    PositionEnrichmentService,
    MatchApprovalService,
    PerformanceService,
  ],
})
export class DashboardModule {}
