import {
  IsDateString,
  IsNumber,
  IsNumberString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import type { IBacktestConfig } from '../../../common/interfaces/backtest-engine.interface';

export class BacktestConfigDto implements IBacktestConfig {
  @IsDateString()
  dateRangeStart!: string;

  @IsDateString()
  dateRangeEnd!: string;

  @IsNumber()
  @Min(0.001)
  @Max(1)
  edgeThresholdPct: number = 0.008;

  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidenceScore: number = 0.8;

  @IsNumber()
  @Min(0)
  @Max(1)
  positionSizePct: number = 0.03;

  @IsInt()
  @Min(1)
  @Max(100)
  maxConcurrentPairs: number = 10;

  @IsNumberString()
  @IsNotEmpty()
  bankrollUsd: string = '10000';

  @IsInt()
  @Min(0)
  @Max(23)
  tradingWindowStartHour: number = 14;

  @IsInt()
  @Min(0)
  @Max(23)
  tradingWindowEndHour: number = 23;

  @IsNumberString()
  @IsNotEmpty()
  gasEstimateUsd: string = '0.50';

  @IsNumber()
  @Min(0)
  @Max(1)
  exitEdgeEvaporationPct: number = 0.002;

  @IsNumber()
  @Min(1)
  exitTimeLimitHours: number = 72;

  @IsNumber()
  @Min(0)
  @Max(1)
  exitProfitCapturePct: number = 0.8;

  @IsOptional()
  @IsBoolean()
  walkForwardEnabled: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(0.9)
  walkForwardTrainPct: number = 0.7;

  @IsInt()
  @Min(60)
  @Max(3600)
  timeoutSeconds: number = 300;
}
