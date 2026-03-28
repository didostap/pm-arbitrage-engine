import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { MatchValidationService } from '../validation/match-validation.service';
import { TriggerValidationDto } from '../dto/match-validation.dto';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';

@Controller('backtesting/validation')
export class MatchValidationController {
  private readonly logger = new Logger(MatchValidationController.name);

  constructor(private readonly validationService: MatchValidationService) {}

  @Post('run')
  @HttpCode(202)
  triggerValidation(@Body() dto: TriggerValidationDto) {
    if (this.validationService.isRunning) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_VALIDATION_FAILURE,
        'Validation already in progress',
        'warning',
        'match-validation',
      );
    }

    const correlationId = crypto.randomUUID();

    // Fire and forget — validation runs asynchronously
    this.validationService
      .runValidation(dto, correlationId)
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Validation run failed: ${msg}`);
      });

    return {
      data: { status: 'accepted', correlationId },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('reports')
  async getReports(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    const reports = await this.validationService.getReports(page, limit);
    return {
      data: reports,
      count: reports.length,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('reports/:id')
  async getReport(@Param('id', ParseIntPipe) id: number) {
    const report = await this.validationService.getReport(id);
    if (!report) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Report ${id} not found`,
        'warning',
        'match-validation',
      );
    }
    return {
      data: report,
      timestamp: new Date().toISOString(),
    };
  }
}
