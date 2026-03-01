import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { DashboardService } from './dashboard.service';
import {
  OverviewResponseDto,
  HealthListResponseDto,
  PositionListResponseDto,
  AlertListResponseDto,
} from './dto';

@Controller('dashboard')
@UseGuards(AuthTokenGuard)
@ApiTags('Dashboard')
@ApiBearerAuth()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Morning scan overview: health, P&L, execution quality, counts',
  })
  async getOverview(): Promise<OverviewResponseDto> {
    const data = await this.dashboardService.getOverview();
    return { data, timestamp: new Date().toISOString() };
  }

  @Get('health')
  @ApiOperation({
    summary: 'Per-platform health status with connectivity details',
  })
  async getHealth(): Promise<HealthListResponseDto> {
    const data = await this.dashboardService.getHealth();
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }

  @Get('positions')
  @ApiOperation({ summary: 'Open positions with edge and P&L details' })
  @ApiQuery({
    name: 'mode',
    required: false,
    enum: ['live', 'paper', 'all'],
    description: 'Filter by trading mode (default: all)',
  })
  async getPositions(
    @Query('mode') mode?: 'live' | 'paper' | 'all',
  ): Promise<PositionListResponseDto> {
    const filterMode = mode === 'all' ? undefined : mode;
    const data = await this.dashboardService.getPositions(filterMode);
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }

  @Get('alerts')
  @ApiOperation({
    summary: 'Active alerts (single-leg exposures, risk limit breaches)',
  })
  async getAlerts(): Promise<AlertListResponseDto> {
    const data = await this.dashboardService.getAlerts();
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }
}
