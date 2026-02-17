import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  RiskConfig,
  RiskDecision,
  RiskExposure,
} from '../../common/types/risk.type';
import { ConfigValidationError } from '../../common/errors/config-validation-error';
import { EVENT_NAMES, LimitApproachedEvent } from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class RiskManagerService implements IRiskManager, OnModuleInit {
  private readonly logger = new Logger(RiskManagerService.name);
  private config!: RiskConfig;
  private openPositionCount = 0;
  private totalCapitalDeployed = new FinancialDecimal(0);

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.validateConfig();
    await this.initializeStateFromDb();
  }

  private validateConfig(): void {
    const bankrollRaw = this.configService.get<string | number>(
      'RISK_BANKROLL_USD',
    );
    const bankroll =
      bankrollRaw !== undefined ? Number(bankrollRaw) : undefined;
    const maxPctRaw = this.configService.get<string | number>(
      'RISK_MAX_POSITION_PCT',
      0.03,
    );
    const maxPct = Number(maxPctRaw);
    const maxPairsRaw = this.configService.get<string | number>(
      'RISK_MAX_OPEN_PAIRS',
      10,
    );
    const maxPairs = Number(maxPairsRaw);

    if (!bankroll || bankroll <= 0) {
      throw new ConfigValidationError(
        'RISK_BANKROLL_USD must be a positive number',
        ['RISK_BANKROLL_USD is invalid or missing'],
      );
    }
    if (maxPct <= 0 || maxPct > 1) {
      throw new ConfigValidationError(
        'RISK_MAX_POSITION_PCT must be between 0 and 1',
        ['RISK_MAX_POSITION_PCT is out of range'],
      );
    }
    if (maxPairs <= 0 || !Number.isInteger(maxPairs)) {
      throw new ConfigValidationError(
        'RISK_MAX_OPEN_PAIRS must be a positive integer',
        ['RISK_MAX_OPEN_PAIRS is invalid'],
      );
    }

    this.config = {
      bankrollUsd: bankroll,
      maxPositionPct: maxPct,
      maxOpenPairs: maxPairs,
    };
    this.logger.log({
      message: 'Risk manager configuration validated',
      data: {
        bankrollMagnitude: `$${Math.pow(10, Math.floor(Math.log10(bankroll)))}+`,
        maxPositionPct: maxPct,
        maxOpenPairs: maxPairs,
      },
    });
  }

  private async initializeStateFromDb(): Promise<void> {
    const state = await this.prisma.riskState.findFirst({
      where: { singletonKey: 'default' },
    });

    if (state) {
      this.openPositionCount = state.openPositionCount;
      this.totalCapitalDeployed = new FinancialDecimal(
        state.totalCapitalDeployed.toString(),
      );
      this.logger.log({
        message: 'Risk state restored from database',
        data: {
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toString(),
        },
      });
    } else {
      await this.persistState();
      this.logger.log({
        message: 'Risk state initialized (new singleton row created)',
      });
    }
  }

  private async persistState(): Promise<void> {
    await this.prisma.riskState.upsert({
      where: { singletonKey: 'default' },
      update: {
        openPositionCount: this.openPositionCount,
        totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
      },
      create: {
        singletonKey: 'default',
        openPositionCount: this.openPositionCount,
        totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  validatePosition(_opportunity: unknown): Promise<RiskDecision> {
    const maxPositionSizeUsd = new FinancialDecimal(
      this.config.bankrollUsd,
    ).mul(new FinancialDecimal(this.config.maxPositionPct));

    // Check max open pairs limit
    if (this.openPositionCount >= this.config.maxOpenPairs) {
      this.logger.warn({
        message: 'Opportunity rejected: max open pairs exceeded',
        data: {
          currentOpenPairs: this.openPositionCount,
          maxOpenPairs: this.config.maxOpenPairs,
        },
      });
      return Promise.resolve({
        approved: false,
        reason: `Max open pairs limit reached (${this.openPositionCount}/${this.config.maxOpenPairs})`,
        maxPositionSizeUsd,
        currentOpenPairs: this.openPositionCount,
      });
    }

    // Check if approaching limit (80% threshold)
    const approachThreshold = Math.floor(this.config.maxOpenPairs * 0.8);
    if (this.openPositionCount >= approachThreshold) {
      const percentUsed =
        (this.openPositionCount / this.config.maxOpenPairs) * 100;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_APPROACHED,
        new LimitApproachedEvent(
          'max_open_pairs',
          this.openPositionCount,
          this.config.maxOpenPairs,
          percentUsed,
        ),
      );
    }

    return Promise.resolve({
      approved: true,
      reason: 'Position within risk limits',
      maxPositionSizeUsd,
      currentOpenPairs: this.openPositionCount,
    });
  }

  getCurrentExposure(): RiskExposure {
    const bankrollUsd = new FinancialDecimal(this.config.bankrollUsd);
    return {
      openPairCount: this.openPositionCount,
      totalCapitalDeployed: this.totalCapitalDeployed,
      bankrollUsd,
      availableCapital: bankrollUsd.minus(this.totalCapitalDeployed),
    };
  }

  getOpenPositionCount(): number {
    return this.openPositionCount;
  }
}
