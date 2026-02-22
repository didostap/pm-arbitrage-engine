import Decimal from 'decimal.js';
import {
  OrderParams,
  OrderResult,
  CancelResult,
  OrderStatusResult,
} from '../../common/types/platform.type';
import {
  PaperTradingConfig,
  SimulatedOrder,
  PAPER_MAX_ORDERS,
} from './paper-trading.types';

/**
 * Simulates order fills for paper trading mode.
 * Plain class — NOT @Injectable(). One instance per PaperTradingConnector.
 */
export class FillSimulatorService {
  private readonly orderMap = new Map<string, SimulatedOrder>();

  constructor(private readonly config: PaperTradingConfig) {}

  async simulateFill(params: OrderParams): Promise<OrderResult> {
    if (this.config.fillLatencyMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.fillLatencyMs),
      );
    }

    const filledPrice = this.applySlippage(params.price, params.side);
    const orderId = crypto.randomUUID();

    const order: SimulatedOrder = {
      orderId,
      platformId: this.config.platformId,
      contractId: params.contractId,
      side: params.side,
      requestedPrice: params.price,
      filledPrice,
      quantity: params.quantity,
      status: 'filled',
      timestamp: new Date(),
    };

    this.evictIfNeeded();
    this.orderMap.set(orderId, order);

    return {
      orderId,
      platformId: this.config.platformId,
      status: 'filled',
      filledQuantity: params.quantity,
      filledPrice,
      timestamp: order.timestamp,
    };
  }

  getOrder(orderId: string): OrderStatusResult {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return { orderId, status: 'not_found' };
    }
    return {
      orderId,
      status: order.status,
      fillPrice: order.filledPrice,
      fillSize: order.quantity,
    };
  }

  cancelOrder(orderId: string): CancelResult {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return { orderId, status: 'not_found' };
    }
    if (order.status === 'filled') {
      return { orderId, status: 'already_filled' };
    }
    // Already cancelled — treat as gone
    return { orderId, status: 'not_found' };
  }

  getOrderCount(): number {
    return this.orderMap.size;
  }

  private applySlippage(price: number, side: 'buy' | 'sell'): number {
    const decimalPrice = new Decimal(price.toString());
    const bps = new Decimal(this.config.slippageBps);
    const multiplier =
      side === 'buy'
        ? new Decimal(1).plus(bps.div(10000))
        : new Decimal(1).minus(bps.div(10000));
    return decimalPrice.mul(multiplier).toNumber();
  }

  private evictIfNeeded(): void {
    if (this.orderMap.size >= PAPER_MAX_ORDERS) {
      const oldestKey = this.orderMap.keys().next().value;
      if (oldestKey) {
        this.orderMap.delete(oldestKey);
      }
    }
  }
}
