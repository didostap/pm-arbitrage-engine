import {
  Body,
  Controller,
  Get,
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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  CLUSTER_CLASSIFIER_TOKEN,
  type IClusterClassifier,
} from '../../common/interfaces/cluster-classifier.interface';
import { RISK_ERROR_CODES } from '../../common/errors/risk-limit-error';
import { RiskOverrideDto } from './dto/risk-override.dto';
import { RiskOverrideResponseDto } from './dto/risk-override-response.dto';
import { ClusterOverrideDto } from './dto/cluster-override.dto';
import {
  ClusterOverrideResponseDto,
  ClusterListResponseDto,
} from './dto/cluster-override-response.dto';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';
import {
  asClusterId,
  asMatchId,
  asOpportunityId,
} from '../../common/types/branded.type';
import { CorrelationTrackerService } from './correlation-tracker.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { ClusterOverrideEvent } from '../../common/events/risk.events';

@ApiTags('Risk Management')
@ApiBearerAuth()
@Controller('risk')
@UseGuards(AuthTokenGuard)
export class RiskOverrideController {
  private readonly logger = new Logger(RiskOverrideController.name);

  constructor(
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    @Inject(CLUSTER_CLASSIFIER_TOKEN)
    private readonly clusterClassifier: IClusterClassifier,
    private readonly correlationTracker: CorrelationTrackerService,
    private readonly eventEmitter: EventEmitter2,
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
        asOpportunityId(dto.opportunityId),
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

  @Post('cluster-override')
  @HttpCode(200)
  @ApiOperation({ summary: 'Override cluster assignment for a contract match' })
  @ApiResponse({ status: 200, type: ClusterOverrideResponseDto })
  @ApiResponse({ status: 404, description: 'Match or cluster not found' })
  async clusterOverride(
    @Body(new ValidationPipe({ whitelist: true })) dto: ClusterOverrideDto,
  ): Promise<ClusterOverrideResponseDto> {
    try {
      const result = await this.clusterClassifier.reassignCluster(
        asMatchId(dto.matchId),
        asClusterId(dto.newClusterId),
        dto.rationale,
      );

      // Recalculate exposure for both old and new clusters
      if (result.oldClusterId) {
        await this.correlationTracker.recalculateClusterExposure(
          result.oldClusterId,
        );
      }
      await this.correlationTracker.recalculateClusterExposure(
        result.newClusterId,
      );

      // Emit override event
      this.eventEmitter.emit(
        EVENT_NAMES.CLUSTER_OVERRIDE,
        new ClusterOverrideEvent(
          asMatchId(dto.matchId),
          result.oldClusterId,
          result.newClusterId,
          dto.rationale,
        ),
      );

      return {
        data: {
          oldClusterId: result.oldClusterId as string | null,
          newClusterId: result.newClusterId as string,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      // Check if it's a 404-type error (match/cluster not found)
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: number }).code === 4007
      ) {
        throw new HttpException(
          {
            error: {
              code: 4007,
              message: error.message,
              severity: 'warning',
            },
            timestamp: new Date().toISOString(),
          },
          404,
        );
      }

      this.logger.error({
        message: 'Cluster override failed',
        data: {
          matchId: dto.matchId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new HttpException(
        {
          error: {
            code: 4000,
            message: 'Internal error processing cluster override',
            severity: 'critical',
          },
          timestamp: new Date().toISOString(),
        },
        500,
      );
    }
  }

  // NOTE: Override history query deferred to Story 9.2 (triage recommendations will need it)

  @Get('clusters')
  @ApiOperation({ summary: 'List all clusters with current exposure' })
  @ApiResponse({ status: 200, type: ClusterListResponseDto })
  listClusters(): ClusterListResponseDto {
    const exposures = this.correlationTracker.getClusterExposures();
    return {
      data: exposures.map((e) => ({
        clusterId: e.clusterId as string,
        clusterName: e.clusterName,
        exposureUsd: e.exposureUsd.toString(),
        exposurePct: e.exposurePct.toString(),
        pairCount: e.pairCount,
      })),
      count: exposures.length,
      timestamp: new Date().toISOString(),
    };
  }
}
