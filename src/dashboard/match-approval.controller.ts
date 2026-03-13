import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { MatchApprovalService } from './match-approval.service';
import {
  ApproveMatchDto,
  RejectMatchDto,
  MatchListQueryDto,
  MatchListResponseDto,
  MatchDetailResponseDto,
  MatchActionResponseDto,
  ClusterListResponseDto,
} from './dto/match-approval.dto';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { asMatchId } from '../common/types/branded.type';

@ApiTags('Contract Matches')
@ApiBearerAuth()
@Controller('matches')
@UseGuards(AuthTokenGuard)
export class MatchApprovalController {
  constructor(private readonly matchApprovalService: MatchApprovalService) {}

  @Get()
  @ApiOperation({
    summary: 'List contract matches with optional status filter',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async listMatches(
    @Query() query: MatchListQueryDto,
  ): Promise<MatchListResponseDto> {
    const status = query.status ?? 'all';
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const result = await this.matchApprovalService.listMatches(
      status,
      page,
      limit,
      query.resolution,
      query.clusterId,
    );

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('clusters')
  @ApiOperation({ summary: 'List all correlation clusters' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listClusters(): Promise<ClusterListResponseDto> {
    const data = await this.matchApprovalService.listClusters();
    return { data, count: data.length, timestamp: new Date().toISOString() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single contract match by ID' })
  @ApiParam({ name: 'id', description: 'Match ID' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Match not found' })
  async getMatchById(@Param('id') id: string): Promise<MatchDetailResponseDto> {
    try {
      const matchId = asMatchId(id);
      const data = await this.matchApprovalService.getMatchById(matchId);
      return { data, timestamp: new Date().toISOString() };
    } catch (error) {
      this.throwHttpFromSystemError(error);
      throw error;
    }
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a pending contract match' })
  @ApiParam({ name: 'id', description: 'Match ID' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Match not found' })
  @ApiResponse({ status: 409, description: 'Match already approved' })
  async approveMatch(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ApproveMatchDto,
  ): Promise<MatchActionResponseDto> {
    try {
      const matchId = asMatchId(id);
      const match = await this.matchApprovalService.approveMatch(
        matchId,
        dto.rationale,
      );
      return {
        data: {
          matchId: match.matchId,
          status: 'approved',
          operatorRationale: dto.rationale,
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.throwHttpFromSystemError(error);
      throw error;
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a contract match' })
  @ApiParam({ name: 'id', description: 'Match ID' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Match not found' })
  @ApiResponse({
    status: 409,
    description: 'Match is approved — cannot reject',
  })
  async rejectMatch(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: RejectMatchDto,
  ): Promise<MatchActionResponseDto> {
    try {
      const matchId = asMatchId(id);
      const match = await this.matchApprovalService.rejectMatch(
        matchId,
        dto.rationale,
      );
      return {
        data: {
          matchId: match.matchId,
          status: 'rejected',
          operatorRationale: dto.rationale,
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.throwHttpFromSystemError(error);
      throw error;
    }
  }

  private throwHttpFromSystemError(error: unknown): void {
    if (error instanceof SystemHealthError) {
      if (error.code === SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND) {
        throw new HttpException(
          {
            error: {
              code: error.code,
              message: error.message,
              severity: error.severity,
            },
            timestamp: new Date().toISOString(),
          },
          404,
        );
      }
      if (error.code === SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED) {
        throw new HttpException(
          {
            error: {
              code: error.code,
              message: error.message,
              severity: error.severity,
            },
            timestamp: new Date().toISOString(),
          },
          409,
        );
      }
    }
  }
}
