import Decimal from 'decimal.js';

export interface SingleLegPnlInput {
  filledPlatform: string;
  filledSide: string;
  fillPrice: number;
  fillSize: number;
  currentPrices: {
    kalshi: { bestBid: number | null; bestAsk: number | null };
    polymarket: { bestBid: number | null; bestAsk: number | null };
  };
  secondaryPlatform: string;
  secondarySide: string;
  /** Taker fee on the filled platform as a decimal (0.00–1.00, e.g. 0.02 = 2%) */
  takerFeeDecimal: number;
  /** Taker fee on the secondary platform as a decimal (0.00–1.00) */
  secondaryTakerFeeDecimal: number;
}

export interface PnlScenarios {
  closeNowEstimate: string;
  retryAtCurrentPrice: string;
  holdRiskAssessment: string;
}

/**
 * Calculates P&L scenarios for a single-leg exposure situation.
 *
 * Close Now: Cost to unwind the filled leg at current market (opposing trade on same platform).
 * Retry: Expected edge if secondary fills at current market price minus fees.
 * Hold: Risk assessment description (exposure amount, time sensitivity).
 */
export function calculateSingleLegPnlScenarios(
  input: SingleLegPnlInput,
): PnlScenarios {
  const {
    filledPlatform,
    filledSide,
    fillPrice,
    fillSize,
    currentPrices,
    secondaryPlatform,
    secondarySide,
    takerFeeDecimal,
    secondaryTakerFeeDecimal,
  } = input;

  const closeNowEstimate = calcCloseNow(
    filledPlatform,
    filledSide,
    fillPrice,
    fillSize,
    currentPrices,
    takerFeeDecimal,
  );

  const retryAtCurrentPrice = calcRetry(
    filledSide,
    fillPrice,
    secondaryPlatform,
    secondarySide,
    currentPrices,
    takerFeeDecimal,
    secondaryTakerFeeDecimal,
  );

  const holdRiskAssessment = calcHold(
    filledPlatform,
    filledSide,
    fillPrice,
    fillSize,
    currentPrices,
  );

  return { closeNowEstimate, retryAtCurrentPrice, holdRiskAssessment };
}

function getPlatformPrices(
  platform: string,
  prices: SingleLegPnlInput['currentPrices'],
): { bestBid: number | null; bestAsk: number | null } {
  return platform === 'kalshi' ? prices.kalshi : prices.polymarket;
}

function calcCloseNow(
  filledPlatform: string,
  filledSide: string,
  fillPrice: number,
  fillSize: number,
  currentPrices: SingleLegPnlInput['currentPrices'],
  takerFeeDecimal: number,
): string {
  const platformPrices = getPlatformPrices(filledPlatform, currentPrices);

  // Buy → unwind by selling at best bid; Sell → unwind by buying at best ask
  const unwindPrice =
    filledSide === 'buy' ? platformPrices.bestBid : platformPrices.bestAsk;

  if (unwindPrice === null) {
    return 'UNAVAILABLE';
  }

  const dFillPrice = new Decimal(fillPrice);
  const dUnwindPrice = new Decimal(unwindPrice);
  const dFillSize = new Decimal(fillSize);
  const dFee = new Decimal(takerFeeDecimal);

  // P&L from the unwind trade
  let pnl: Decimal;
  if (filledSide === 'buy') {
    // Bought at fillPrice, selling at unwindPrice
    pnl = dUnwindPrice.minus(dFillPrice).times(dFillSize);
  } else {
    // Sold at fillPrice, buying back at unwindPrice
    pnl = dFillPrice.minus(dUnwindPrice).times(dFillSize);
  }

  // Subtract taker fee on the unwind trade
  const feeAmount = dUnwindPrice.times(dFillSize).times(dFee);
  pnl = pnl.minus(feeAmount);

  return pnl.toFixed(2);
}

function calcRetry(
  filledSide: string,
  fillPrice: number,
  secondaryPlatform: string,
  secondarySide: string,
  currentPrices: SingleLegPnlInput['currentPrices'],
  takerFeeDecimal: number,
  secondaryTakerFeeDecimal: number,
): string {
  const secondaryPrices = getPlatformPrices(secondaryPlatform, currentPrices);

  // For the secondary leg: if selling, use best bid; if buying, use best ask
  const secondaryCurrentPrice =
    secondarySide === 'sell'
      ? secondaryPrices.bestBid
      : secondaryPrices.bestAsk;

  if (secondaryCurrentPrice === null) {
    return 'UNAVAILABLE';
  }

  const dFillPrice = new Decimal(fillPrice);
  const dSecondaryPrice = new Decimal(secondaryCurrentPrice);
  const dFee = new Decimal(takerFeeDecimal);
  const dSecFee = new Decimal(secondaryTakerFeeDecimal);

  // Net edge: |filledPrice - secondaryCurrentPrice| - fees
  const grossEdge = dFillPrice.minus(dSecondaryPrice).abs();
  const filledFee = dFillPrice.times(dFee);
  const secondaryFee = dSecondaryPrice.times(dSecFee);
  const netEdge = grossEdge.minus(filledFee).minus(secondaryFee);

  // Calculate percentage relative to average of the two prices
  const avgPrice = dFillPrice.plus(dSecondaryPrice).div(2);
  const edgePercent = avgPrice.isZero()
    ? new Decimal(0)
    : netEdge.div(avgPrice).times(100);

  if (netEdge.greaterThan(0)) {
    return `Retry would yield ~${edgePercent.toFixed(2)}% edge`;
  } else {
    return `Retry at current price would result in ~${edgePercent.abs().toFixed(2)}% loss`;
  }
}

function calcHold(
  filledPlatform: string,
  filledSide: string,
  fillPrice: number,
  fillSize: number,
  currentPrices: SingleLegPnlInput['currentPrices'],
): string {
  const dFillPrice = new Decimal(fillPrice);
  const dFillSize = new Decimal(fillSize);
  const exposureUsd = dFillPrice.times(dFillSize).toFixed(2);

  let assessment = `EXPOSED: $${exposureUsd} on ${filledPlatform} (${filledSide} ${fillSize}@${fillPrice}). No hedge. Immediate operator action recommended.`;

  // Check if any prices are unavailable
  const allNull =
    currentPrices.kalshi.bestBid === null &&
    currentPrices.kalshi.bestAsk === null &&
    currentPrices.polymarket.bestBid === null &&
    currentPrices.polymarket.bestAsk === null;

  if (allNull) {
    assessment +=
      ' Current market prices unavailable — risk assessment may be stale.';
  }

  return assessment;
}

/**
 * Builds recommended actions ordered by preference based on P&L scenarios.
 */
export function buildRecommendedActions(
  pnlScenarios: PnlScenarios,
  positionId: string,
): string[] {
  const actions: string[] = [];

  // 1. If retry shows positive edge
  if (
    pnlScenarios.retryAtCurrentPrice !== 'UNAVAILABLE' &&
    pnlScenarios.retryAtCurrentPrice.includes('yield')
  ) {
    actions.push(
      pnlScenarios.retryAtCurrentPrice.replace(
        'Retry would',
        'Retry secondary leg —',
      ),
    );
  }

  // 2. If close now is available and retry is not profitable (loss or unavailable)
  if (
    pnlScenarios.closeNowEstimate !== 'UNAVAILABLE' &&
    !pnlScenarios.retryAtCurrentPrice.includes('yield')
  ) {
    actions.push(
      `Close filled leg — estimated loss $${new Decimal(pnlScenarios.closeNowEstimate).abs().toFixed(2)}`,
    );
  }

  // 3. Always include monitor action
  actions.push(
    `Monitor position via \`GET /api/positions/${positionId}\` — Story 5.3 will add retry/close endpoints`,
  );

  return actions;
}
