import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { DashboardService } from './dashboard.service';
import {
  OverviewResponseDto,
  HealthListResponseDto,
  PositionDetailResponseDto,
  PositionFullDetailResponseDto,
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
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 50, max: 200)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description:
      'Comma-separated status filter (e.g. "OPEN,EXIT_PARTIAL"). Omit for default open statuses. Empty string for all statuses.',
  })
  async getPositions(
    @Query('mode') mode?: 'live' | 'paper' | 'all',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<PositionListResponseDto> {
    const filterMode = mode === 'all' ? undefined : mode;
    const pageNum = Math.max(1, page ? parseInt(page, 10) : 1);
    const limitNum = Math.min(
      Math.max(1, limit ? parseInt(limit, 10) : 50),
      200,
    );
    const result = await this.dashboardService.getPositions(
      filterMode,
      pageNum,
      limitNum,
      status,
    );
    return {
      data: result.data,
      count: result.count,
      page: pageNum,
      limit: limitNum,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('positions/:id/details')
  @ApiOperation({
    summary:
      'Full position breakdown with orders, audit trail, and capital analysis',
  })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({
    status: 200,
    description: 'Full position detail',
    type: PositionFullDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Position not found' })
  async getPositionDetails(
    @Param('id') id: string,
  ): Promise<PositionFullDetailResponseDto> {
    const data = await this.dashboardService.getPositionDetails(id);
    if (!data) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Position ${id} not found`,
        'warning',
        'DashboardController',
      );
    }
    return { data, timestamp: new Date().toISOString() };
  }

  @Get('positions/:id')
  @ApiOperation({ summary: 'Single position detail with enriched P&L data' })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({
    status: 200,
    description: 'Position found and enriched',
    type: PositionDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Position not found' })
  async getPositionById(
    @Param('id') id: string,
  ): Promise<PositionDetailResponseDto> {
    const data = await this.dashboardService.getPositionById(id);
    if (!data) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Position ${id} not found`,
        'warning',
        'DashboardController',
      );
    }
    return { data, timestamp: new Date().toISOString() };
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
