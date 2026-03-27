import { Module, forwardRef } from '@nestjs/common';
import { PersistenceModule } from '../../../common/persistence.module';
import { EngineModule } from '../engine/engine.module';
import { CalibrationReportService } from './calibration-report.service';
import { WalkForwardService } from './walk-forward.service';
import { SensitivityAnalysisService } from './sensitivity-analysis.service';

@Module({
  imports: [PersistenceModule, forwardRef(() => EngineModule)],
  providers: [
    CalibrationReportService,
    WalkForwardService,
    SensitivityAnalysisService,
  ],
  exports: [
    CalibrationReportService,
    WalkForwardService,
    SensitivityAnalysisService,
  ],
})
export class ReportingModule {}
