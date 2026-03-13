import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { quantile, standardDeviation, probit } from 'simple-statistics';
import { PrismaService } from '../../common/prisma.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  StressTestCompletedEvent,
  StressTestAlertEvent,
} from '../../common/events/risk.events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { withCorrelationId } from '../../common/services/correlation-context';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import type {
  StressTestResult,
  RiskExposure,
} from '../../common/types/risk.type';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';

/** Correlation coefficient for positions in the same cluster */
const CLUSTER_CORRELATION_RHO = 0.7;
const RHO_COMPLEMENT = Math.sqrt(1 - CLUSTER_CORRELATION_RHO ** 2);

interface PositionLeg {
  contractId: string;
  platform: string;
  side: string;
  entryPrice: Decimal;
  sizeUsd: Decimal;
  clusterId: string | null;
  volatility: number;
  volSource: string;
}

@Injectable()
export class StressTestService {
  private readonly logger = new Logger(StressTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
  ) {}

  @Cron('0 0 0 * * 0', { timeZone: 'UTC' })
  async handleWeeklyCron(): Promise<void> {
    await withCorrelationId(async () => {
      try {
        await this.runSimulation('cron');
      } catch (error) {
        this.logger.error({
          message: 'Weekly stress test cron failed',
          module: 'risk-management',
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      }
    });
  }

  async runSimulation(
    triggeredBy: 'cron' | 'operator',
  ): Promise<StressTestResult> {
    const numScenarios = this.configService.get<number>(
      'STRESS_TEST_SCENARIOS',
      1000,
    );
    const defaultDailyVol = this.configService.get<string>(
      'STRESS_TEST_DEFAULT_DAILY_VOL',
      '0.03',
    );
    const minSnapshots = this.configService.get<number>(
      'STRESS_TEST_MIN_SNAPSHOTS',
      30,
    );

    const exposure = this.riskManager.getCurrentExposure();
    const bankrollUsd = new FinancialDecimal(exposure.bankrollUsd);

    // Zero bankroll guard
    if (bankrollUsd.lessThanOrEqualTo(0)) {
      this.logger.warn({
        message: 'Stress test skipped — bankroll is zero',
        module: 'risk-management',
      });
      return this.persistAndEmitNeutralResult(
        triggeredBy,
        bankrollUsd,
        numScenarios,
      );
    }

    // Fetch open positions
    const positions = await this.prisma.openPosition.findMany({
      where: {
        status: {
          in: [
            'OPEN',
            'SINGLE_LEG_EXPOSED',
            'EXIT_PARTIAL',
            'RECONCILIATION_REQUIRED',
          ],
        },
      },
      include: { pair: true, kalshiOrder: true, polymarketOrder: true },
    });

    if (positions.length === 0) {
      return this.persistAndEmitNeutralResult(
        triggeredBy,
        bankrollUsd,
        numScenarios,
      );
    }

    // Build position legs
    const legs = await this.buildPositionLegs(
      positions,
      defaultDailyVol,
      minSnapshots,
    );

    // Collect unique cluster IDs
    const clusterIds = [
      ...new Set(legs.map((l) => l.clusterId).filter(Boolean)),
    ] as string[];

    // Run Monte Carlo random scenarios
    const portfolioPnls: number[] = [];

    for (let s = 0; s < numScenarios; s++) {
      const clusterFactors = new Map<string, number>();
      for (const cid of clusterIds) {
        clusterFactors.set(cid, normalRandom());
      }
      const pnl = this.simulateScenario(legs, clusterFactors, false);
      portfolioPnls.push(pnl);
    }

    // Run synthetic adverse scenarios
    const syntheticResults = this.runSyntheticScenarios(legs, clusterIds);
    for (const synthetic of syntheticResults) {
      portfolioPnls.push(parseFloat(synthetic.portfolioPnl));
    }

    const totalScenarios = portfolioPnls.length;

    // Calculate metrics
    const sortedPnls = [...portfolioPnls].sort((a, b) => a - b);
    const var95 = new FinancialDecimal(
      Math.max(0, -quantile(sortedPnls, 0.05)),
    );
    const var99 = new FinancialDecimal(
      Math.max(0, -quantile(sortedPnls, 0.01)),
    );
    const worstCaseLoss = new FinancialDecimal(
      Math.max(0, -(sortedPnls[0] ?? 0)),
    );

    // Drawdown probabilities
    const bankrollNum = bankrollUsd.toNumber();
    let count15 = 0;
    let count20 = 0;
    let count25 = 0;
    for (const pnl of portfolioPnls) {
      if (pnl < 0) {
        const drawdownPct = -pnl / bankrollNum;
        if (drawdownPct > 0.15) count15++;
        if (drawdownPct > 0.2) count20++;
        if (drawdownPct > 0.25) count25++;
      }
    }
    const drawdown15PctProbability = new FinancialDecimal(
      count15 / totalScenarios,
    );
    const drawdown20PctProbability = new FinancialDecimal(
      count20 / totalScenarios,
    );
    const drawdown25PctProbability = new FinancialDecimal(
      count25 / totalScenarios,
    );

    // Percentiles for scenario details
    const pctPoints = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
    const percentiles: Record<string, string> = {};
    for (const p of pctPoints) {
      const label = `p${Math.round(p * 100)}`;
      percentiles[label] = quantile(sortedPnls, p).toFixed(2);
    }

    // Volatilities used
    const volatilities = legs.map((l) => ({
      contractId: l.contractId,
      platform: l.platform,
      vol: l.volatility.toFixed(6),
      source: l.volSource,
    }));

    // Alert logic
    let alertEmitted = false;
    let suggestions: string[] = [];
    if (drawdown20PctProbability.greaterThan(new Decimal('0.05'))) {
      alertEmitted = true;
      suggestions = this.generateSuggestions(exposure, positions.length);

      this.eventEmitter.emit(
        EVENT_NAMES.STRESS_TEST_ALERT,
        new StressTestAlertEvent(
          var95,
          var99,
          worstCaseLoss,
          drawdown20PctProbability,
          suggestions,
        ),
      );
    }

    const result: StressTestResult = {
      numScenarios: totalScenarios,
      numPositions: positions.length,
      bankrollUsd,
      var95,
      var99,
      worstCaseLoss,
      drawdown15PctProbability,
      drawdown20PctProbability,
      drawdown25PctProbability,
      alertEmitted,
      suggestions,
      scenarioDetails: {
        percentiles,
        syntheticResults,
        volatilities,
      },
    };

    await this.persistResult(result, triggeredBy);

    this.eventEmitter.emit(
      EVENT_NAMES.STRESS_TEST_COMPLETED,
      new StressTestCompletedEvent(
        totalScenarios,
        positions.length,
        var95,
        var99,
        worstCaseLoss,
        drawdown20PctProbability,
      ),
    );

    return result;
  }

  private async buildPositionLegs(
    positions: Array<{
      positionId: string;
      polymarketSide: string | null;
      kalshiSide: string | null;
      entryPrices: unknown;
      sizes: unknown;
      pair: {
        polymarketContractId: string;
        kalshiContractId: string;
        clusterId: string | null;
      };
      polymarketOrder: { contractId: string } | null;
      kalshiOrder: { contractId: string } | null;
    }>,
    defaultDailyVol: string,
    minSnapshots: number,
  ): Promise<PositionLeg[]> {
    const legs: PositionLeg[] = [];
    const volCache = new Map<string, { vol: number; source: string }>();

    for (const pos of positions) {
      const entryPrices = pos.entryPrices as {
        polymarket?: string;
        kalshi?: string;
      };
      const sizes = pos.sizes as { polymarket?: string; kalshi?: string };

      // Polymarket leg
      if (pos.polymarketSide && entryPrices.polymarket && sizes.polymarket) {
        const contractId = pos.pair.polymarketContractId;
        const volInfo = await this.getVolatility(
          'POLYMARKET',
          contractId,
          defaultDailyVol,
          minSnapshots,
          volCache,
        );
        legs.push({
          contractId,
          platform: 'POLYMARKET',
          side: pos.polymarketSide,
          entryPrice: new FinancialDecimal(entryPrices.polymarket),
          sizeUsd: new FinancialDecimal(sizes.polymarket),
          clusterId: pos.pair.clusterId,
          volatility: volInfo.vol,
          volSource: volInfo.source,
        });
      }

      // Kalshi leg
      if (pos.kalshiSide && entryPrices.kalshi && sizes.kalshi) {
        const contractId = pos.pair.kalshiContractId;
        const volInfo = await this.getVolatility(
          'KALSHI',
          contractId,
          defaultDailyVol,
          minSnapshots,
          volCache,
        );
        legs.push({
          contractId,
          platform: 'KALSHI',
          side: pos.kalshiSide,
          entryPrice: new FinancialDecimal(entryPrices.kalshi),
          sizeUsd: new FinancialDecimal(sizes.kalshi),
          clusterId: pos.pair.clusterId,
          volatility: volInfo.vol,
          volSource: volInfo.source,
        });
      }
    }

    return legs;
  }

  private async getVolatility(
    platform: string,
    contractId: string,
    defaultDailyVol: string,
    minSnapshots: number,
    cache: Map<string, { vol: number; source: string }>,
  ): Promise<{ vol: number; source: string }> {
    const cacheKey = `${platform}:${contractId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const snapshots = await this.prisma.orderBookSnapshot.findMany({
      where: {
        platform: platform as 'KALSHI' | 'POLYMARKET',
        contract_id: contractId,
        created_at: { gte: sevenDaysAgo },
      },
      orderBy: { created_at: 'asc' },
    });

    if (snapshots.length >= minSnapshots) {
      const midpoints = snapshots.map((s) => {
        const bids = s.bids as Array<{ price: number; quantity: number }>;
        const asks = s.asks as Array<{ price: number; quantity: number }>;
        const bestBid = bids[0]?.price ?? 0;
        const bestAsk = asks[0]?.price ?? 1;
        return (bestBid + bestAsk) / 2;
      });

      // Additive returns (not log — bounded domain)
      const returns: number[] = [];
      for (let i = 1; i < midpoints.length; i++) {
        returns.push((midpoints[i] ?? 0) - (midpoints[i - 1] ?? 0));
      }

      if (returns.length > 1) {
        const vol = standardDeviation(returns);
        const result = {
          vol: Math.max(vol, 0.001),
          source: 'historical' as const,
        };
        cache.set(cacheKey, result);
        return result;
      }
    }

    const result = {
      vol: parseFloat(defaultDailyVol),
      source: 'default' as const,
    };
    cache.set(cacheKey, result);
    return result;
  }

  private simulateScenario(
    legs: PositionLeg[],
    clusterFactors: Map<string, number>,
    isAdverse: boolean,
    adverseMultiplier: number = 1,
  ): number {
    let portfolioPnl = new FinancialDecimal(0);

    for (const leg of legs) {
      let shock: number;
      if (isAdverse) {
        // Adverse: worst-case direction per position
        const adverseDir = leg.side === 'BUY' ? -1 : 1;
        shock = adverseDir * 3 * leg.volatility * adverseMultiplier;
      } else {
        const clusterFactor =
          leg.clusterId && clusterFactors.has(leg.clusterId)
            ? clusterFactors.get(leg.clusterId)!
            : 0;
        const idiosyncratic = normalRandom();
        const correlatedShock = leg.clusterId
          ? clusterFactor * CLUSTER_CORRELATION_RHO +
            idiosyncratic * RHO_COMPLEMENT
          : idiosyncratic;
        shock = correlatedShock * leg.volatility;
      }

      // Bounded price model: clamp to [0, 1]
      const currentPrice = leg.entryPrice.toNumber();
      const newPrice = Math.max(0, Math.min(1, currentPrice + shock));

      // P&L calculation
      const priceDelta = new FinancialDecimal(newPrice).minus(leg.entryPrice);
      const legPnl =
        leg.side === 'BUY'
          ? priceDelta.mul(leg.sizeUsd)
          : priceDelta.neg().mul(leg.sizeUsd);

      portfolioPnl = portfolioPnl.plus(legPnl);
    }

    return portfolioPnl.toNumber();
  }

  private runSyntheticScenarios(
    legs: PositionLeg[],
    clusterIds: string[],
  ): { name: string; portfolioPnl: string }[] {
    const results: { name: string; portfolioPnl: string }[] = [];

    // 1. Correlation-1 stress: all adverse simultaneously
    const corr1Pnl = this.simulateScenario(legs, new Map(), true);
    results.push({
      name: 'correlation-1-stress',
      portfolioPnl: corr1Pnl.toFixed(2),
    });

    // 2. Single-cluster blowup: each cluster gets adverse 3σ, others random
    for (const clusterId of clusterIds) {
      const clusterLegs = legs.filter((l) => l.clusterId === clusterId);
      const otherLegs = legs.filter((l) => l.clusterId !== clusterId);

      // Cluster legs get adverse shocks
      const clusterPnl = this.simulateScenario(clusterLegs, new Map(), true);
      // Other legs get random shocks
      const otherFactors = new Map<string, number>();
      for (const cid of clusterIds) {
        if (cid !== clusterId) otherFactors.set(cid, normalRandom());
      }
      const otherPnl = this.simulateScenario(otherLegs, otherFactors, false);

      results.push({
        name: `cluster-blowup-${clusterId}`,
        portfolioPnl: (clusterPnl + otherPnl).toFixed(2),
      });
    }

    // 3. Liquidity gap: 2x volatility shock in adverse direction
    const liqPnl = this.simulateScenario(legs, new Map(), true, 2 / 3);
    // 2/3 because adverse uses 3σ, and we want 2σ total → multiplier of 2/3 on the 3σ
    results.push({
      name: 'liquidity-gap',
      portfolioPnl: liqPnl.toFixed(2),
    });

    return results;
  }

  private generateSuggestions(
    exposure: RiskExposure,
    openPairCount: number,
  ): string[] {
    const suggestions: string[] = [];
    const maxPositionPct = parseFloat(
      this.configService.get<string>('RISK_MAX_POSITION_PCT', '0.03'),
    );
    const maxOpenPairs = this.configService.get<number>(
      'RISK_MAX_OPEN_PAIRS',
      10,
    );

    // 1. High cluster concentration
    for (const cluster of exposure.clusterExposures) {
      if (cluster.exposurePct.greaterThan(new Decimal('0.10'))) {
        suggestions.push(
          `Cluster '${cluster.clusterName}' at ${cluster.exposurePct.mul(100).toFixed(1)}% exposure — reduce correlated positions to lower tail risk`,
        );
      }
    }

    // 2. Large position sizes
    if (maxPositionPct > 0.02 && exposure.bankrollUsd.greaterThan(0)) {
      suggestions.push(
        `Reduce RISK_MAX_POSITION_PCT from ${(maxPositionPct * 100).toFixed(0)}% to 2% — large positions drive tail losses`,
      );
    }

    // 3. Many open pairs
    if (openPairCount > maxOpenPairs * 0.8) {
      suggestions.push(
        `At ${openPairCount}/${maxOpenPairs} open pairs — consider reducing RISK_MAX_OPEN_PAIRS to limit portfolio complexity`,
      );
    }

    // 4. High total deployment
    if (
      exposure.bankrollUsd.greaterThan(0) &&
      exposure.totalCapitalDeployed
        .div(exposure.bankrollUsd)
        .greaterThan(new Decimal('0.5'))
    ) {
      const pct = exposure.totalCapitalDeployed
        .div(exposure.bankrollUsd)
        .mul(100)
        .toFixed(1);
      suggestions.push(
        `Capital deployment at ${pct}% of bankroll — reduce overall exposure`,
      );
    }

    // Generic fallback
    if (suggestions.length === 0) {
      suggestions.push(
        'Current risk parameters produce >5% probability of 20%+ drawdown — review position sizing and concentration limits',
      );
    }

    return suggestions;
  }

  private async persistAndEmitNeutralResult(
    triggeredBy: 'cron' | 'operator',
    bankrollUsd: Decimal,
    numScenarios: number,
  ): Promise<StressTestResult> {
    const zero = new FinancialDecimal(0);
    const result: StressTestResult = {
      numScenarios,
      numPositions: 0,
      bankrollUsd,
      var95: zero,
      var99: zero,
      worstCaseLoss: zero,
      drawdown15PctProbability: zero,
      drawdown20PctProbability: zero,
      drawdown25PctProbability: zero,
      alertEmitted: false,
      suggestions: [],
      scenarioDetails: {
        percentiles: {},
        syntheticResults: [],
        volatilities: [],
      },
    };

    await this.persistResult(result, triggeredBy);

    this.eventEmitter.emit(
      EVENT_NAMES.STRESS_TEST_COMPLETED,
      new StressTestCompletedEvent(numScenarios, 0, zero, zero, zero, zero),
    );

    return result;
  }

  private async persistResult(
    result: StressTestResult,
    triggeredBy: string,
  ): Promise<void> {
    await this.prisma.stressTestRun.create({
      data: {
        timestamp: new Date(),
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
        triggeredBy,
      },
    });
  }
}

/** Generate a standard normal random variate using simple-statistics probit */
function normalRandom(): number {
  // Clamp to avoid -Infinity/+Infinity from probit(0) or probit(1)
  const u = Math.max(1e-10, Math.min(1 - 1e-10, Math.random()));
  return probit(u);
}
