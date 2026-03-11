import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CalibrationService } from './calibration.service.js';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard.js';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@UseGuards(AuthTokenGuard)
@Controller('api/knowledge-base')
export class CalibrationController {
  constructor(private readonly calibrationService: CalibrationService) {}

  @Post('calibration')
  @ApiOperation({ summary: 'Trigger calibration analysis' })
  async runCalibration() {
    const result = await this.calibrationService.runCalibration();
    return { data: result, timestamp: new Date().toISOString() };
  }

  @Get('calibration')
  @ApiOperation({ summary: 'Get latest calibration result' })
  getCalibration() {
    const result = this.calibrationService.getLatestResult();
    return { data: result, timestamp: new Date().toISOString() };
  }
}
