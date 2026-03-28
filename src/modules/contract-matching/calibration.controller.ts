import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { CalibrationService } from './calibration.service.js';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard.js';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@UseGuards(AuthTokenGuard)
@Controller('knowledge-base')
export class CalibrationController {
  constructor(private readonly calibrationService: CalibrationService) {}

  @Post('calibration')
  @ApiOperation({ summary: 'Trigger calibration analysis' })
  async runCalibration() {
    const result = await this.calibrationService.runCalibration('operator');
    return { data: result, timestamp: new Date().toISOString() };
  }

  @Get('calibration')
  @ApiOperation({ summary: 'Get latest calibration result' })
  getCalibration() {
    const result = this.calibrationService.getLatestResult();
    return { data: result, timestamp: new Date().toISOString() };
  }

  @Get('calibration/history')
  @ApiOperation({ summary: 'Get calibration run history' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of recent runs to return (default: 10)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of calibration runs ordered by timestamp descending',
  })
  async getCalibrationHistory(@Query('limit') limitParam?: string) {
    const limit = limitParam ? parseInt(limitParam, 10) : 10;
    const safeLimit =
      Number.isNaN(limit) || limit < 1 ? 10 : Math.min(limit, 100);
    const { data, count } =
      await this.calibrationService.getCalibrationHistory(safeLimit);
    return { data, count, timestamp: new Date().toISOString() };
  }
}
