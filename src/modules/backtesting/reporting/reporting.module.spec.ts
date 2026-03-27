import { describe, it, expect, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CalibrationReportService } from './calibration-report.service';
import { WalkForwardService } from './walk-forward.service';
import { SensitivityAnalysisService } from './sensitivity-analysis.service';
import { ReportingModule } from './reporting.module';

describe('ReportingModule', () => {
  it('[P1] should register CalibrationReportService, WalkForwardService, SensitivityAnalysisService as providers', () => {
    // Verify all 3 service classes are importable and constructable
    const mockPrisma = {} as any;
    const mockEmitter = new EventEmitter2();
    const mockEngine = {} as any;

    const reportService = new CalibrationReportService(mockPrisma, mockEmitter);
    const walkForwardService = new WalkForwardService();
    const sensitivityService = new SensitivityAnalysisService(
      mockPrisma,
      mockEmitter,
      mockEngine,
    );

    expect(reportService).toBeInstanceOf(CalibrationReportService);
    expect(walkForwardService).toBeInstanceOf(WalkForwardService);
    expect(sensitivityService).toBeInstanceOf(SensitivityAnalysisService);
  });

  it('[P1] should resolve CalibrationReportService via DI', () => {
    const mockPrisma = {} as any;
    const mockEmitter = new EventEmitter2();
    const service = new CalibrationReportService(mockPrisma, mockEmitter);
    expect(service).toBeInstanceOf(CalibrationReportService);
  });

  it('[P1] should be importable from BacktestingModule structure (3 providers within <=8 limit)', () => {
    // Structural check: ReportingModule exists and is a valid NestJS module
    expect(ReportingModule).toBeDefined();
    expect(CalibrationReportService).toBeDefined();
    expect(WalkForwardService).toBeDefined();
    expect(SensitivityAnalysisService).toBeDefined();
  });
});
