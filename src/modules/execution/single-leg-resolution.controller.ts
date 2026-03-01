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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { RetryLegDto } from './retry-leg.dto';
import { CloseLegDto } from './close-leg.dto';
import {
  RetryLegResponseDto,
  CloseLegResponseDto,
} from './dto/single-leg-response.dto';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';

@ApiTags('Positions')
@ApiBearerAuth()
@Controller('positions')
@UseGuards(AuthTokenGuard)
export class SingleLegResolutionController {
  private readonly logger = new Logger(SingleLegResolutionController.name);

  constructor(private readonly resolutionService: SingleLegResolutionService) {}

  @Post(':id/retry-leg')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry the failed leg of a single-leg exposure' })
  @ApiResponse({ status: 409, description: 'Invalid position state' })
  @ApiResponse({ status: 502, description: 'Platform connector failure' })
  async retryLeg(
    @Param('id') positionId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: RetryLegDto,
  ): Promise<RetryLegResponseDto> {
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
  @ApiOperation({ summary: 'Close the filled leg to exit single-leg exposure' })
  @ApiResponse({ status: 409, description: 'Invalid position state' })
  @ApiResponse({ status: 422, description: 'Cannot determine close price' })
  async closeLeg(
    @Param('id') positionId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: CloseLegDto,
  ): Promise<CloseLegResponseDto> {
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
          severity: 'critical',
        },
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}
