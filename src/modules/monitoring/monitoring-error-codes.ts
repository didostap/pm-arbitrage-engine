/** Monitoring error codes (range 4006+ within SystemHealthError 4000-4999). */
export const MONITORING_ERROR_CODES = {
  /** Telegram alert send failed — warning, retry via buffer drain */
  TELEGRAM_SEND_FAILED: 4006,
  /** Event consumer handler failed — warning, error isolated */
  EVENT_CONSUMER_HANDLER_FAILED: 4007,
  /** CSV trade log write failed — warning, never halts engine */
  CSV_WRITE_FAILED: 4008,
  /** Export rate limit exceeded — warning, 5 req/min per token */
  EXPORT_RATE_LIMIT_EXCEEDED: 4009,
  /** Audit log DB write failed — hash chain may be compromised */
  AUDIT_LOG_WRITE_FAILED: 4010,
  /** Audit hash chain integrity check failed — tampering detected */
  AUDIT_HASH_CHAIN_BROKEN: 4011,
  /** Date range exceeds allowed maximum */
  INVALID_DATE_RANGE: 4012,
} as const;
