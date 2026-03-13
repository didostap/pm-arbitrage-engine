import { Module } from '@nestjs/common';
import { RiskManagerService } from './risk-manager.service';
import { RiskOverrideController } from './risk-override.controller';
import { StressTestController } from './stress-test.controller';
import { StressTestService } from './stress-test.service';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';
import { CorrelationTrackerService } from './correlation-tracker.service';
import { ContractMatchingModule } from '../contract-matching/contract-matching.module';

export { RISK_MANAGER_TOKEN };

@Module({
  imports: [ContractMatchingModule],
  controllers: [RiskOverrideController, StressTestController],
  providers: [
    {
      provide: RISK_MANAGER_TOKEN,
      useClass: RiskManagerService,
    },
    CorrelationTrackerService,
    StressTestService,
    AuthTokenGuard,
  ],
  exports: [RISK_MANAGER_TOKEN, CorrelationTrackerService],
})
export class RiskManagementModule {}
