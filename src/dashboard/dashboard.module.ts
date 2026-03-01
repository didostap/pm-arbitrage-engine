import { Module } from '@nestjs/common';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardGateway, DashboardEventMapperService, DashboardService],
})
export class DashboardModule {}
