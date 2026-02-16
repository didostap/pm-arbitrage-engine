import { SystemError } from './system-error.js';

/**
 * Thrown when contract pair config validation fails at startup.
 * Code 4010 — SystemHealth range (4000-4999).
 * Severity: critical — engine cannot operate without valid contract pairs.
 */
export class ConfigValidationError extends SystemError {
  constructor(message: string, validationErrors: string[]) {
    super(4010, message, 'critical', undefined, { validationErrors });
  }
}
