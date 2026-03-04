import { Module } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PositionEnrichmentService } from './position-enrichment.service';
import { MatchApprovalController } from './match-approval.controller';
import { MatchApprovalService } from './match-approval.service';
import { DataIngestionModule } from '../modules/data-ingestion/data-ingestion.module';

@Module({
  imports: [DataIngestionModule],
  controllers: [DashboardController, MatchApprovalController],
  providers: [
    DashboardGateway,
    DashboardEventMapperService,
    DashboardService,
    PositionEnrichmentService,
    MatchApprovalService,
  ],
})
export class DashboardModule {}
