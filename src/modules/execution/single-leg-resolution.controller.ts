import {
  Controller,
  Post,
  Param,
  Body,
  HttpCode,
  HttpException,
  UseGuards,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { RetryLegDto } from './retry-leg.dto';
import { CloseLegDto } from './close-leg.dto';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';

@Controller('api/positions')
@UseGuards(AuthTokenGuard)
export class SingleLegResolutionController {
  private readonly logger = new Logger(SingleLegResolutionController.name);

  constructor(private readonly resolutionService: SingleLegResolutionService) {}

  @Post(':id/retry-leg')
  @HttpCode(200)
  async retryLeg(
    @Param('id') positionId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: RetryLegDto,
  ) {
    try {
      const result = await this.resolutionService.retryLeg(
        positionId,
        dto.price,
      );
      return { data: result, timestamp: new Date().toISOString() };
    } catch (error) {
      throw this.mapError(error, 'retry-leg', positionId);
    }
  }

  @Post(':id/close-leg')
  @HttpCode(200)
  async closeLeg(
    @Param('id') positionId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: CloseLegDto,
  ) {
    try {
      const result = await this.resolutionService.closeLeg(
        positionId,
        dto.rationale,
      );
      return { data: result, timestamp: new Date().toISOString() };
    } catch (error) {
      throw this.mapError(error, 'close-leg', positionId);
    }
  }

  private mapError(
    error: unknown,
    operation: string,
    positionId: string,
  ): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    if (error instanceof ExecutionError) {
      const code = error.code;
      let httpStatus: number;

      if (code === EXECUTION_ERROR_CODES.INVALID_POSITION_STATE) {
        httpStatus = 409;
      } else if (
        code === EXECUTION_ERROR_CODES.CLOSE_FAILED &&
        error.severity === 'warning'
      ) {
        // Empty order book / cannot determine close price
        httpStatus = 422;
      } else {
        // Platform connector failure
        httpStatus = 502;
      }

      return new HttpException(
        {
          error: {
            code,
            message: error.message,
            severity: error.severity,
          },
          timestamp: new Date().toISOString(),
        },
        httpStatus,
      );
    }

    this.logger.error({
      message: `Unexpected error in ${operation}`,
      data: {
        positionId,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return new HttpException(
      {
        error: {
          code: 4000,
          message: 'Internal error processing request',
          severity: 'error',
        },
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}
