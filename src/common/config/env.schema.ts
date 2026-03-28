import { z } from 'zod';

/**
 * Reusable refinement for env vars destined for new Decimal().
 * Keeps values as validated strings — z.coerce.number() would introduce
 * floating-point precision loss before Decimal() receives the value.
 */
const decimalString = (defaultVal: string) =>
  z
    .string()
    .default(defaultVal)
    .refine((val) => /^-?\d+(\.\d+)?$/.test(val), {
      message: 'Must be a valid decimal number string (e.g., "0.008", "10000")',
    });

export const envSchema = z.object({
  // Application
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // Database
  DATABASE_URL: z.string().min(1),

  // Trading Engine
  POLLING_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  TRADING_WINDOW_START_UTC: z.coerce.number().int().min(0).max(23).default(0),
  TRADING_WINDOW_END_UTC: z.coerce.number().int().min(1).max(24).default(24),

  // Kalshi
  KALSHI_API_KEY_ID: z.string().default(''),
  KALSHI_PRIVATE_KEY_PATH: z.string().default('./secrets/key.pem'),
  KALSHI_API_BASE_URL: z.string().url().default('https://demo-api.kalshi.co'),
  KALSHI_API_TIER: z
    .enum(['BASIC', 'ADVANCED', 'PREMIER', 'PRIME'])
    .default('BASIC'),

  // Polymarket
  POLYMARKET_PRIVATE_KEY: z.string().default(''),
  POLYMARKET_CLOB_API_URL: z
    .string()
    .url()
    .default('https://clob.polymarket.com'),
  POLYMARKET_WS_URL: z
    .string()
    .url()
    .default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_RPC_URL: z.string().url().default('https://polygon-rpc.com'),
  POLYMARKET_GAMMA_API_URL: z
    .string()
    .url()
    .default('https://gamma-api.polymarket.com'),

  // Goldsky Subgraph (Polymarket on-chain data)
  GOLDSKY_SUBGRAPH_URL: z
    .string()
    .url()
    .default(
      'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn',
    ),

  // Edge Calculation (String → Decimal)
  DETECTION_MIN_EDGE_THRESHOLD: decimalString('0.008'),
  DETECTION_GAS_ESTIMATE_USD: decimalString('0.30'),
  DETECTION_POSITION_SIZE_USD: decimalString('300'),
  /** Minimum annualized return threshold for capital efficiency gating (FR-AD-08). Default 15%. */
  MIN_ANNUALIZED_RETURN: decimalString('0.15'),

  // Gas Estimation
  GAS_BUFFER_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
  GAS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  GAS_POL_PRICE_FALLBACK_USD: decimalString('0.40'),
  POLYMARKET_SETTLEMENT_GAS_UNITS: z.coerce
    .number()
    .int()
    .positive()
    .default(150000),

  // Detection Depth (String → Decimal)
  DETECTION_MIN_FILL_RATIO: decimalString('0.25'),
  /** Scaling factor for depth-sensitive edge threshold. 0 disables dynamic scaling. */
  DEPTH_EDGE_SCALING_FACTOR: decimalString('10'),
  /** Maximum dynamic edge threshold cap (decimal probability, e.g. 0.05 = 5%). */
  MAX_DYNAMIC_EDGE_THRESHOLD: decimalString('0.05'),

  // Execution Depth (String → Decimal)
  EXECUTION_MIN_FILL_RATIO: decimalString('0.25'),
  DUAL_LEG_MIN_DEPTH_RATIO: decimalString('1.0'),

  // Risk Management (String → Decimal)
  RISK_BANKROLL_USD: decimalString('10000'),
  RISK_MAX_POSITION_PCT: decimalString('0.03'),
  RISK_MAX_OPEN_PAIRS: z.coerce.number().int().positive().default(10),
  RISK_DAILY_LOSS_PCT: decimalString('0.05'),

  // Operator Auth — no well-known default; must be set in .env
  OPERATOR_API_TOKEN: z.string().min(1),

  // Platform Modes
  PLATFORM_MODE_KALSHI: z.enum(['live', 'paper']).default('live'),
  PLATFORM_MODE_POLYMARKET: z.enum(['live', 'paper']).default('live'),
  PAPER_FILL_LATENCY_MS_KALSHI: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(150),
  PAPER_SLIPPAGE_BPS_KALSHI: z.coerce.number().int().nonnegative().default(5),
  PAPER_FILL_LATENCY_MS_POLYMARKET: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(800),
  PAPER_SLIPPAGE_BPS_POLYMARKET: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(15),
  ALLOW_MIXED_MODE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_TEST_ALERT_CRON: z.string().default('0 8 * * *'),
  TELEGRAM_TEST_ALERT_TIMEZONE: z.string().default('UTC'),
  TELEGRAM_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  TELEGRAM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  TELEGRAM_BUFFER_MAX_SIZE: z.coerce.number().int().positive().default(100),
  TELEGRAM_CIRCUIT_BREAK_MS: z.coerce.number().int().positive().default(60000),

  // CSV Logging
  CSV_TRADE_LOG_DIR: z.string().default('./data/trade-logs'),
  CSV_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // Compliance
  COMPLIANCE_MATRIX_CONFIG_PATH: z
    .string()
    .default('config/compliance-matrix.yaml'),

  // Dashboard
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:5173'),

  // LLM Scoring
  LLM_PRIMARY_PROVIDER: z.enum(['gemini', 'anthropic']).default('gemini'),
  LLM_PRIMARY_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  LLM_PRIMARY_API_KEY: z.string().default(''),
  LLM_ESCALATION_PROVIDER: z.enum(['gemini', 'anthropic']).default('anthropic'),
  LLM_ESCALATION_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  LLM_ESCALATION_API_KEY: z.string().default(''),
  LLM_ESCALATION_MIN: z.coerce.number().int().min(0).max(100).default(60),
  LLM_ESCALATION_MAX: z.coerce.number().int().min(0).max(100).default(84),
  LLM_AUTO_APPROVE_THRESHOLD: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(85),
  LLM_MIN_REVIEW_THRESHOLD: z.coerce.number().int().min(0).max(100).default(40),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // Discovery
  DISCOVERY_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  DISCOVERY_RUN_ON_STARTUP: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  DISCOVERY_CRON_EXPRESSION: z.string().default('0 0 8,20 * * *'),
  DISCOVERY_PREFILTER_THRESHOLD: decimalString('0.25'),
  DISCOVERY_SETTLEMENT_WINDOW_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(7),
  DISCOVERY_MAX_CANDIDATES_PER_CONTRACT: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  DISCOVERY_LLM_CONCURRENCY: z.coerce.number().int().positive().default(10),

  // Resolution Polling
  RESOLUTION_POLLER_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  RESOLUTION_POLLER_CRON_EXPRESSION: z.string().default('0 0 6 * * *'),
  RESOLUTION_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(100),

  // Calibration
  CALIBRATION_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  CALIBRATION_CRON_EXPRESSION: z.string().default('0 0 7 1 */3 *'),

  // Orderbook Staleness (Story 9.1b) — platform-level orderbook data staleness alert threshold
  ORDERBOOK_STALENESS_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(90_000),

  // WS Staleness (Story 10.1) — per-position WS freshness threshold for exit monitor data source classification
  WS_STALENESS_THRESHOLD_MS: z.coerce.number().int().positive().default(60_000),

  // Polling Concurrency (Story 9.15) — max concurrent getOrderBook() calls per platform
  KALSHI_POLLING_CONCURRENCY: z.coerce.number().int().positive().default(10),
  POLYMARKET_POLLING_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // Cluster Classification
  CLUSTER_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  RISK_CLUSTER_HARD_LIMIT_PCT: decimalString('0.15'),
  RISK_CLUSTER_SOFT_LIMIT_PCT: decimalString('0.12'),
  RISK_AGGREGATE_CLUSTER_LIMIT_PCT: decimalString('0.50'),

  // Audit Log Retention (Story 9.6) — 0 = disabled (for Phase 1+ 7-year retention compliance)
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),

  // Stress Testing (Story 9.4) — Monte Carlo simulation parameters
  STRESS_TEST_SCENARIOS: z.coerce.number().int().positive().default(1000),
  STRESS_TEST_DEFAULT_DAILY_VOL: decimalString('0.03'),
  STRESS_TEST_MIN_SNAPSHOTS: z.coerce.number().int().positive().default(30),

  // Auto-Unwind (Story 10.3) — automatic single-leg management
  AUTO_UNWIND_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AUTO_UNWIND_DELAY_MS: z.coerce.number().int().min(0).max(30000).default(2000),
  AUTO_UNWIND_MAX_LOSS_PCT: z.coerce.number().min(0).max(100).default(5),

  // Adaptive Sequencing (Story 10.4) — latency-based leg ordering
  ADAPTIVE_SEQUENCING_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(200),

  // Polymarket Order Polling (Story 10.4) — configurable poll timeout and interval
  POLYMARKET_ORDER_POLL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(5000),
  POLYMARKET_ORDER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(5000)
    .default(500),

  // Exit Mode (Story 10.2) — six-criteria model-driven exit logic
  EXIT_MODE: z.enum(['fixed', 'model', 'shadow']).default('fixed'),
  EXIT_EDGE_EVAP_MULTIPLIER: z.coerce.number().max(0).default(-1.0),
  EXIT_CONFIDENCE_DROP_PCT: z.coerce.number().int().min(1).max(100).default(20),
  EXIT_TIME_DECAY_HORIZON_H: z.coerce.number().int().positive().default(168),
  EXIT_TIME_DECAY_STEEPNESS: z.coerce.number().positive().default(2.0),
  EXIT_TIME_DECAY_TRIGGER: z.coerce.number().min(0).max(1).default(0.8),
  EXIT_RISK_BUDGET_PCT: z.coerce.number().int().min(1).max(100).default(85),
  EXIT_RISK_RANK_CUTOFF: z.coerce.number().int().positive().default(1),
  EXIT_MIN_DEPTH: z.coerce.number().int().positive().default(5),
  EXIT_DEPTH_SLIPPAGE_TOLERANCE: z.coerce.number().min(0).max(1).default(0.02),
  EXIT_MAX_CHUNK_SIZE: z.coerce.number().int().min(0).default(0),
  EXIT_PROFIT_CAPTURE_RATIO: z.coerce.number().min(0.01).max(5).default(0.5),

  // Pair Concentration Limits (Story 10-7-6) — per-pair cooldown, concurrent, diversity
  PAIR_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(30),
  PAIR_MAX_CONCURRENT_POSITIONS: z.coerce.number().int().min(0).default(2),
  PAIR_DIVERSITY_THRESHOLD: z.coerce.number().int().min(0).default(5),

  // Incremental Ingestion (Story 10-9-6) — cron schedule + staleness thresholds
  INCREMENTAL_INGESTION_CRON_EXPRESSION: z.string().default('0 0 2 * * *'),
  INCREMENTAL_INGESTION_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  STALENESS_THRESHOLD_PLATFORM_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(129_600_000),
  STALENESS_THRESHOLD_PMXT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(172_800_000),
  STALENESS_THRESHOLD_ODDSPIPE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(129_600_000),
  STALENESS_THRESHOLD_VALIDATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(259_200_000),
});
