export type { IPlatformConnector } from './platform-connector.interface.js';
export type { IRiskManager } from './risk-manager.interface.js';
export type { IExecutionQueue } from './execution-queue.interface.js';
export type {
  IExecutionEngine,
  ExecutionResult,
} from './execution-engine.interface.js';
export type { IPriceFeedService } from './price-feed-service.interface.js';
export { PRICE_FEED_SERVICE_TOKEN } from './price-feed-service.interface.js';
export type {
  IPositionCloseService,
  PositionCloseResult,
  BatchPositionResult,
} from './position-close-service.interface.js';
export { POSITION_CLOSE_SERVICE_TOKEN } from './position-close-service.interface.js';
export type {
  IScoringStrategy,
  ScoringResult,
  ResolutionContext,
} from './scoring-strategy.interface.js';
export { SCORING_STRATEGY_TOKEN } from './scoring-strategy.interface.js';
export type {
  IContractCatalogProvider,
  ContractSummary,
  ResolutionOutcome,
} from './contract-catalog-provider.interface.js';
export {
  KALSHI_CATALOG_TOKEN,
  POLYMARKET_CATALOG_TOKEN,
} from './contract-catalog-provider.interface.js';
