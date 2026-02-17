import { Module } from '@nestjs/common';
import { RiskManagerService } from './risk-manager.service';
import { RiskOverrideController } from './risk-override.controller';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';

export { RISK_MANAGER_TOKEN };

@Module({
  controllers: [RiskOverrideController],
  providers: [
    {
      provide: RISK_MANAGER_TOKEN,
      useClass: RiskManagerService,
    },
    AuthTokenGuard,
  ],
  exports: [RISK_MANAGER_TOKEN],
})
export class RiskManagementModule {}
