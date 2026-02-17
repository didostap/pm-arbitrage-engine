import { Module } from '@nestjs/common';
import { RiskManagerService } from './risk-manager.service';

const RISK_MANAGER_TOKEN = 'IRiskManager';

@Module({
  providers: [
    {
      provide: RISK_MANAGER_TOKEN,
      useClass: RiskManagerService,
    },
  ],
  exports: [RISK_MANAGER_TOKEN],
})
export class RiskManagementModule {}
