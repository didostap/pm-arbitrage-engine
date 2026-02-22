import { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { NormalizedOrderBook } from '../../common/types/normalized-order-book.type';
import {
  CancelResult,
  FeeSchedule,
  OrderParams,
  OrderResult,
  OrderStatusResult,
  PlatformHealth,
  PlatformId,
  Position,
} from '../../common/types/platform.type';
import { FillSimulatorService } from './fill-simulator.service';
import { PaperTradingConfig } from './paper-trading.types';

/**
 * Wraps a real IPlatformConnector: delegates data methods to the real connector,
 * intercepts execution methods with simulated fills.
 * Plain class — NOT @Injectable(). Instantiated by ConnectorModule factory.
 */
export class PaperTradingConnector implements IPlatformConnector {
  private readonly fillSimulator: FillSimulatorService;

  constructor(
    private readonly realConnector: IPlatformConnector,
    config: PaperTradingConfig,
  ) {
    this.fillSimulator = new FillSimulatorService(config);
  }

  // --- Data method delegation (real market data) ---

  getOrderBook(contractId: string): Promise<NormalizedOrderBook> {
    return this.realConnector.getOrderBook(contractId);
  }

  getFeeSchedule(): FeeSchedule {
    return this.realConnector.getFeeSchedule();
  }

  getPlatformId(): PlatformId {
    return this.realConnector.getPlatformId();
  }

  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.realConnector.onOrderBookUpdate(callback);
  }

  getPositions(): Promise<Position[]> {
    return this.realConnector.getPositions();
  }

  connect(): Promise<void> {
    return this.realConnector.connect();
  }

  disconnect(): Promise<void> {
    return this.realConnector.disconnect();
  }

  // --- Execution method interception (simulated) ---

  submitOrder(params: OrderParams): Promise<OrderResult> {
    return this.fillSimulator.simulateFill(params);
  }

  cancelOrder(orderId: string): Promise<CancelResult> {
    return Promise.resolve(this.fillSimulator.cancelOrder(orderId));
  }

  getOrder(orderId: string): Promise<OrderStatusResult> {
    return Promise.resolve(this.fillSimulator.getOrder(orderId));
  }

  // --- Health augmentation ---

  getHealth(): PlatformHealth {
    const health = this.realConnector.getHealth();
    return { ...health, mode: 'paper' as const };
  }
}
