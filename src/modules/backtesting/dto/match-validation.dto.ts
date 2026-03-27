import { IsArray, IsIn, IsOptional } from 'class-validator';
import type {
  ExternalMatchSource,
  ValidationReportEntry,
  ValidationReportSummary,
} from '../types/match-validation.types';

const VALID_SOURCES: ExternalMatchSource[] = ['oddspipe', 'predexon'];

export class TriggerValidationDto {
  @IsOptional()
  @IsArray()
  @IsIn(VALID_SOURCES, { each: true })
  includeSources?: ExternalMatchSource[];
}

export function getEffectiveSources(
  includeSources?: ExternalMatchSource[],
): ExternalMatchSource[] {
  if (!includeSources || includeSources.length === 0) {
    return ['oddspipe', 'predexon'];
  }
  return includeSources;
}

export class ValidationReportResponseDto {
  reportId!: number;
  summary!: ValidationReportSummary;
  entries!: ValidationReportEntry[];
}
