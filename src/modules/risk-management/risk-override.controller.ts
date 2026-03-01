import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import { RISK_ERROR_CODES } from '../../common/errors/risk-limit-error';
import { RiskOverrideDto } from './dto/risk-override.dto';
import { RiskOverrideResponseDto } from './dto/risk-override-response.dto';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';

@ApiTags('Risk Management')
@ApiBearerAuth()
@Controller('risk')
@UseGuards(AuthTokenGuard)
export class RiskOverrideController {
  private readonly logger = new Logger(RiskOverrideController.name);

  constructor(
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
  ) {}

  @Post('override')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit operator risk override for an opportunity' })
  @ApiResponse({
    status: 403,
    description: 'Override denied — trading halt active',
  })
  async override(
    @Body(new ValidationPipe({ whitelist: true })) dto: RiskOverrideDto,
  ): Promise<RiskOverrideResponseDto> {
    try {
      const decision = await this.riskManager.processOverride(
        dto.opportunityId,
        dto.rationale,
      );

      if (!decision.approved) {
        throw new HttpException(
          {
            error: {
              code: RISK_ERROR_CODES.OVERRIDE_DENIED_HALT_ACTIVE,
              message: decision.reason,
              severity: 'critical',
            },
            timestamp: new Date().toISOString(),
          },
          403,
        );
      }

      return {
        data: {
          approved: decision.approved,
          reason: decision.reason,
          maxPositionSizeUsd: decision.maxPositionSizeUsd.toString(),
          currentOpenPairs: decision.currentOpenPairs,
          dailyPnl: decision.dailyPnl?.toString(),
          overrideApplied: decision.overrideApplied,
          overrideRationale: decision.overrideRationale,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error({
        message: 'Override processing failed',
        data: {
          opportunityId: dto.opportunityId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new HttpException(
        {
          error: {
            code: 4000,
            message: 'Internal error processing override',
            severity: 'critical',
          },
          timestamp: new Date().toISOString(),
        },
        500,
      );
    }
  }
}
