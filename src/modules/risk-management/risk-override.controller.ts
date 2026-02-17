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
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import { RISK_ERROR_CODES } from '../../common/errors/risk-limit-error';
import { RiskOverrideDto } from './dto/risk-override.dto';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';

@Controller('api/risk')
@UseGuards(AuthTokenGuard)
export class RiskOverrideController {
  private readonly logger = new Logger(RiskOverrideController.name);

  constructor(
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
  ) {}

  @Post('override')
  @HttpCode(200)
  async override(
    @Body(new ValidationPipe({ whitelist: true })) dto: RiskOverrideDto,
  ) {
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

      return { data: decision, timestamp: new Date().toISOString() };
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
            severity: 'error',
          },
          timestamp: new Date().toISOString(),
        },
        500,
      );
    }
  }
}
