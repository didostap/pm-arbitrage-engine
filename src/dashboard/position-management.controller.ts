import {
  Controller,
  Post,
  Param,
  Body,
  Inject,
  HttpCode,
  HttpException,
  HttpStatus,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import {
  POSITION_CLOSE_SERVICE_TOKEN,
  type IPositionCloseService,
} from '../common/interfaces/position-close-service.interface';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { ClosePositionDto } from './dto/close-position.dto';
import { CloseAllPositionsDto } from './dto/close-all-positions.dto';
import { asPositionId } from '../common/types/branded.type';

@ApiTags('Position Management')
@ApiBearerAuth()
@Controller('api/positions')
@UseGuards(AuthTokenGuard)
export class PositionManagementController {
  constructor(
    @Inject(POSITION_CLOSE_SERVICE_TOKEN)
    private readonly closeService: IPositionCloseService,
  ) {}

  @Post('close-all')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Close all open positions in a batch' })
  @ApiResponse({ status: 202, description: 'Batch close initiated' })
  async closeAll(
    @Body(new ValidationPipe({ whitelist: true })) dto: CloseAllPositionsDto,
  ) {
    const result = await this.closeService.closeAllPositions(dto.rationale);
    return {
      data: result,
      timestamp: new Date().toISOString(),
    };
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Manually close a position across both platforms' })
  @ApiResponse({ status: 200, description: 'Position closed successfully' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  @ApiResponse({
    status: 422,
    description: 'Position is not in a closeable state',
  })
  async closePosition(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ClosePositionDto,
  ) {
    const positionId = asPositionId(id);
    const result = await this.closeService.closePosition(
      positionId,
      dto.rationale,
    );

    if (!result.success) {
      if (result.errorCode === 'NOT_FOUND') {
        throw new HttpException(
          {
            error: {
              code: 4004,
              message: result.error,
              severity: 'warning',
            },
            timestamp: new Date().toISOString(),
          },
          404,
        );
      }

      throw new HttpException(
        {
          error: {
            code: 2005,
            message: result.error ?? 'Position close failed',
            severity: 'error',
          },
          timestamp: new Date().toISOString(),
        },
        422,
      );
    }

    return {
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
