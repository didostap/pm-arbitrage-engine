/**
 * Result of NTP time synchronization and drift measurement
 */
export interface DriftResult {
  /** Absolute drift in milliseconds between system time and NTP time */
  driftMs: number;

  /** NTP server used for synchronization */
  serverUsed: string;

  /** Timestamp when the measurement was taken */
  timestamp: Date;
}
