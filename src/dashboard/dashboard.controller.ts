import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
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
  PositionsQueryDto,
  BankrollConfigResponseDto,
  UpdateBankrollDto,
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
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async getPositions(
    @Query() query: PositionsQueryDto,
  ): Promise<PositionListResponseDto> {
    const filterMode = query.mode === 'all' ? undefined : query.mode;
    const pageNum = query.page ?? 1;
    const limitNum = query.limit ?? 50;
    const result = await this.dashboardService.getPositions(
      filterMode,
      pageNum,
      limitNum,
      query.status,
      query.sortBy,
      query.order,
      query.matchId,
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

  @Get('config/bankroll')
  @ApiOperation({ summary: 'Get current bankroll configuration' })
  @ApiResponse({ status: 200, type: BankrollConfigResponseDto })
  async getBankrollConfig(): Promise<BankrollConfigResponseDto> {
    const data = await this.dashboardService.getBankrollConfig();
    return { data, timestamp: new Date().toISOString() };
  }

  @Put('config/bankroll')
  @ApiOperation({ summary: 'Update bankroll value (hot-reload, no restart)' })
  @ApiResponse({ status: 200, type: BankrollConfigResponseDto })
  async updateBankroll(
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateBankrollDto,
  ): Promise<BankrollConfigResponseDto> {
    const data = await this.dashboardService.updateBankroll(dto.bankrollUsd);
    return { data, timestamp: new Date().toISOString() };
  }
}
