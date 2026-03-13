import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StressTestService } from './stress-test.service';
import { PrismaService } from '../../common/prisma.service';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import {
  StressTestResponseDto,
  StressTestTriggerResponseDto,
} from './dto/stress-test.dto';

@ApiTags('Risk Management')
@ApiBearerAuth()
@Controller('risk/stress-test')
@UseGuards(AuthTokenGuard)
export class StressTestController {
  constructor(
    private readonly stressTestService: StressTestService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Trigger manual Monte Carlo stress test' })
  @ApiResponse({
    status: 200,
    description: 'Stress test results',
    type: StressTestTriggerResponseDto,
  })
  async triggerStressTest(): Promise<StressTestTriggerResponseDto> {
    const result = await this.stressTestService.runSimulation('operator');

    return {
      data: {
        numScenarios: result.numScenarios,
        numPositions: result.numPositions,
        bankrollUsd: result.bankrollUsd.toFixed(8),
        var95: result.var95.toFixed(8),
        var99: result.var99.toFixed(8),
        worstCaseLoss: result.worstCaseLoss.toFixed(8),
        drawdown15PctProbability: result.drawdown15PctProbability.toFixed(6),
        drawdown20PctProbability: result.drawdown20PctProbability.toFixed(6),
        drawdown25PctProbability: result.drawdown25PctProbability.toFixed(6),
        alertEmitted: result.alertEmitted,
        suggestions: result.suggestions,
        scenarioDetails: result.scenarioDetails,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get most recent stress test result' })
  @ApiResponse({
    status: 200,
    description: 'Latest stress test result',
    type: StressTestResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No stress test runs exist' })
  async getLatestResult(): Promise<StressTestResponseDto> {
    const latest = await this.prisma.stressTestRun.findFirst({
      orderBy: { timestamp: 'desc' },
    });

    if (!latest) {
      throw new HttpException(
        {
          error: {
            code: 4008,
            message: 'No stress test runs found',
            severity: 'info',
          },
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }

    return {
      data: {
        numScenarios: latest.numScenarios,
        numPositions: latest.numPositions,
        bankrollUsd: latest.bankrollUsd.toString(),
        var95: latest.var95.toString(),
        var99: latest.var99.toString(),
        worstCaseLoss: latest.worstCaseLoss.toString(),
        drawdown15PctProbability: latest.drawdown15PctProbability.toString(),
        drawdown20PctProbability: latest.drawdown20PctProbability.toString(),
        drawdown25PctProbability: latest.drawdown25PctProbability.toString(),
        alertEmitted: latest.alertEmitted,
        suggestions: (latest.suggestions as string[]) ?? [],
        scenarioDetails: latest.scenarioDetails as {
          percentiles: Record<string, string>;
          syntheticResults: { name: string; portfolioPnl: string }[];
          volatilities: {
            contractId: string;
            platform: string;
            vol: string;
            source: string;
          }[];
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
