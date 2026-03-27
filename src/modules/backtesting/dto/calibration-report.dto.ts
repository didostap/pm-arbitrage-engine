import {
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  IsArray,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SweepRangeDto {
  @IsNumber()
  @Min(0)
  min!: number;

  @IsNumber()
  @Min(0)
  max!: number;

  @IsNumber()
  @Min(0.0001)
  step!: number;
}

export class TradingWindowVariantDto {
  @IsNumber()
  @Min(0)
  @Max(24)
  startHour!: number;

  @IsNumber()
  @Min(0)
  @Max(24)
  endHour!: number;

  @IsString()
  label!: string;
}

export class SweepConfigDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => SweepRangeDto)
  edgeThresholdRange?: SweepRangeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SweepRangeDto)
  positionSizeRange?: SweepRangeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SweepRangeDto)
  maxConcurrentPairsRange?: SweepRangeDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TradingWindowVariantDto)
  tradingWindowVariants?: TradingWindowVariantDto[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(7200)
  timeoutSeconds?: number;
}

export class CalibrationReportResponseDto {
  summaryMetrics!: Record<string, unknown>;
  confidenceIntervals!: Record<string, unknown>;
  knownLimitations!: string[];
  dataQualitySummary!: Record<string, unknown>;
  generatedAt!: string;
}

export class SensitivityResultsResponseDto {
  sweeps!: Record<string, unknown>[];
  degradationBoundaries!: Record<string, unknown>[];
  recommendedParameters!: Record<string, unknown>;
  partial!: boolean;
  completedSweeps!: number;
  totalPlannedSweeps!: number;
}

export class WalkForwardResultsResponseDto {
  trainPct!: number;
  testPct!: number;
  trainMetrics!: Record<string, unknown>;
  testMetrics!: Record<string, unknown>;
  degradation!: Record<string, unknown>;
  overfitFlags!: string[];
}
