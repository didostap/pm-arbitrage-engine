/** Monitoring error codes (range 4006+ within SystemHealthError 4000-4999). */
export const MONITORING_ERROR_CODES = {
  /** Telegram alert send failed — warning, retry via buffer drain */
  TELEGRAM_SEND_FAILED: 4006,
} as const;
