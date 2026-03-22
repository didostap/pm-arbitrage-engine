import { BaseEvent } from './base.event';

export class BankrollUpdatedEvent extends BaseEvent {
  constructor(
    public readonly previousValue: string,
    public readonly newValue: string,
    public readonly updatedBy: string = 'dashboard',
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/** JSON-serializable config field value (matches EffectiveConfig value types) */
export type ConfigFieldValue = string | number | boolean | null;

/** Story 10-5.2 AC5 — Emitted on PATCH or reset of DB-backed settings. */
export class ConfigSettingsUpdatedEvent extends BaseEvent {
  constructor(
    public readonly changedFields: Record<
      string,
      { previous: ConfigFieldValue; current: ConfigFieldValue }
    >,
    public readonly updatedBy: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
