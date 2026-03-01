import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
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
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { StartupReconciliationService } from './startup-reconciliation.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { ResolveReconciliationDto } from './dto/resolve-reconciliation.dto';
import {
  ResolveDiscrepancyResponseDto,
  ReconciliationRunResponseDto,
  ReconciliationStatusResponseDto,
} from './dto/reconciliation-response.dto';

const DEBOUNCE_MS = 30_000;

@ApiTags('Reconciliation')
@ApiBearerAuth()
@Controller('reconciliation')
@UseGuards(AuthTokenGuard)
export class ReconciliationController {
  private readonly logger = new Logger(ReconciliationController.name);

  constructor(
    private readonly reconciliationService: StartupReconciliationService,
    private readonly positionRepository: PositionRepository,
  ) {}

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a reconciliation discrepancy' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  @ApiResponse({
    status: 409,
    description: 'Position not in reconciliation state',
  })
  async resolve(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true }))
    dto: ResolveReconciliationDto,
  ): Promise<ResolveDiscrepancyResponseDto> {
    try {
      const result = await this.reconciliationService.resolveDiscrepancy(
        id,
        dto.action,
        dto.rationale,
      );
      return { data: result, timestamp: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not found')) {
        throw new HttpException(
          {
            error: { code: 404, message, severity: 'warning' },
            timestamp: new Date().toISOString(),
          },
          404,
        );
      }

      if (message.includes('not in RECONCILIATION_REQUIRED')) {
        throw new HttpException(
          {
            error: { code: 409, message, severity: 'warning' },
            timestamp: new Date().toISOString(),
          },
          409,
        );
      }

      this.logger.error({
        message: 'Resolve discrepancy failed',
        data: { positionId: id, error: message },
      });
      throw new HttpException(
        {
          error: {
            code: 4000,
            message: 'Internal error resolving discrepancy',
            severity: 'critical',
          },
          timestamp: new Date().toISOString(),
        },
        500,
      );
    }
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Trigger manual reconciliation run' })
  @ApiResponse({ status: 429, description: 'Reconciliation debounce active' })
  async run(): Promise<ReconciliationRunResponseDto> {
    const lastRunAt = this.reconciliationService.lastRunAt;
    if (lastRunAt && Date.now() - lastRunAt.getTime() < DEBOUNCE_MS) {
      throw new HttpException(
        {
          error: {
            code: 429,
            message: 'Reconciliation was run less than 30 seconds ago',
            severity: 'info',
          },
          timestamp: new Date().toISOString(),
        },
        429,
      );
    }

    try {
      const result = await this.reconciliationService.reconcile();
      return { data: result, timestamp: new Date().toISOString() };
    } catch (error) {
      this.logger.error({
        message: 'Manual reconciliation failed',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new HttpException(
        {
          error: {
            code: 4000,
            message: 'Internal error running reconciliation',
            severity: 'critical',
          },
          timestamp: new Date().toISOString(),
        },
        500,
      );
    }
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get reconciliation status and outstanding discrepancies',
  })
  async status(): Promise<ReconciliationStatusResponseDto> {
    const lastRun = this.reconciliationService.getLastRunResult();
    // Live positions only (isPaper defaults to false) — paper positions are excluded
    const outstandingPositions = await this.positionRepository.findByStatus(
      'RECONCILIATION_REQUIRED',
    );

    return {
      data: {
        lastRun,
        lastRunAt: this.reconciliationService.lastRunAt?.toISOString() ?? null,
        outstandingDiscrepancies: outstandingPositions.length,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
