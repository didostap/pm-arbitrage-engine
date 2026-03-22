import { describe, it, expect } from 'vitest';
import {
  SETTINGS_METADATA,
  SettingsGroup,
  RESETTABLE_SETTINGS_KEYS,
} from './settings-metadata.js';
import { CONFIG_DEFAULTS } from './config-defaults.js';

/** Valid metadata type discriminators for the `type` field */
const VALID_TYPES = [
  'boolean',
  'integer',
  'decimal',
  'float',
  'string',
  'enum',
] as const;

describe('SETTINGS_METADATA', () => {
  it('[P0] keys match CONFIG_DEFAULTS keys (SETTINGS_METADATA → CONFIG_DEFAULTS)', () => {
    const metadataKeys = Object.keys(SETTINGS_METADATA).sort();
    const defaultKeys = Object.keys(CONFIG_DEFAULTS).sort();
    expect(metadataKeys).toEqual(defaultKeys);
  });

  it('[P0] keys match CONFIG_DEFAULTS keys (CONFIG_DEFAULTS → SETTINGS_METADATA)', () => {
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      expect(
        SETTINGS_METADATA,
        `CONFIG_DEFAULTS key "${key}" missing from SETTINGS_METADATA`,
      ).toHaveProperty(key);
    }
  });

  it('[P1] SettingsGroup has exactly 15 members', () => {
    const allGroups = Object.values(SettingsGroup);
    expect(allGroups).toHaveLength(15);
  });

  it('[P1] all non-placeholder groups are represented in at least one entry', () => {
    const groupsUsed = new Set(
      Object.values(SETTINGS_METADATA).map((entry) => entry.group),
    );

    // Paper Trading is a placeholder group with no Cat B fields
    const nonPlaceholderGroups = Object.values(SettingsGroup).filter(
      (g) => g !== SettingsGroup.PaperTrading,
    );

    for (const group of nonPlaceholderGroups) {
      expect(
        groupsUsed.has(group),
        `SettingsGroup.${group} is not used by any SETTINGS_METADATA entry`,
      ).toBe(true);
    }
  });

  it('[P1] type values are valid for every entry', () => {
    for (const [key, entry] of Object.entries(SETTINGS_METADATA)) {
      expect(
        VALID_TYPES as readonly string[],
        `SETTINGS_METADATA["${key}"].type="${entry.type}" is not a valid type`,
      ).toContain(entry.type);
    }
  });

  it('[P1] entries with type "enum" have a non-empty options array', () => {
    for (const [key, entry] of Object.entries(SETTINGS_METADATA)) {
      if (entry.type === 'enum') {
        expect(
          Array.isArray(entry.options),
          `SETTINGS_METADATA["${key}"] has type="enum" but options is not an array`,
        ).toBe(true);
        expect(
          entry.options!.length,
          `SETTINGS_METADATA["${key}"] has type="enum" but options is empty`,
        ).toBeGreaterThan(0);
        for (const option of entry.options!) {
          expect(typeof option).toBe('string');
        }
      }
    }
  });

  it('[P1] entries with min/max have numeric type', () => {
    const numericTypes = ['integer', 'decimal', 'float'];

    for (const [key, entry] of Object.entries(SETTINGS_METADATA)) {
      if (entry.min !== undefined || entry.max !== undefined) {
        expect(
          numericTypes,
          `SETTINGS_METADATA["${key}"] has min/max but type="${entry.type}" is not numeric`,
        ).toContain(entry.type);
      }
    }
  });

  it('[P1] constraint parity: min/max match env.schema.ts Zod constraints', () => {
    // gasBufferPercent: z.coerce.number().int().min(0).max(100)
    expect(SETTINGS_METADATA.gasBufferPercent.min).toBe(0);
    expect(SETTINGS_METADATA.gasBufferPercent.max).toBe(100);
    expect(SETTINGS_METADATA.gasBufferPercent.type).toBe('integer');

    // autoUnwindDelayMs: z.coerce.number().int().min(0).max(30000)
    expect(SETTINGS_METADATA.autoUnwindDelayMs.min).toBe(0);
    expect(SETTINGS_METADATA.autoUnwindDelayMs.max).toBe(30000);
    expect(SETTINGS_METADATA.autoUnwindDelayMs.type).toBe('integer');

    // exitEdgeEvapMultiplier: z.coerce.number().max(0)
    expect(SETTINGS_METADATA.exitEdgeEvapMultiplier.max).toBe(0);
    expect(SETTINGS_METADATA.exitEdgeEvapMultiplier.type).toBe('float');

    // exitProfitCaptureRatio: z.coerce.number().min(0.01).max(5)
    expect(SETTINGS_METADATA.exitProfitCaptureRatio.min).toBe(0.01);
    expect(SETTINGS_METADATA.exitProfitCaptureRatio.max).toBe(5);
    expect(SETTINGS_METADATA.exitProfitCaptureRatio.type).toBe('float');

    // auditLogRetentionDays: z.coerce.number().int().min(0).max(3650)
    expect(SETTINGS_METADATA.auditLogRetentionDays.min).toBe(0);
    expect(SETTINGS_METADATA.auditLogRetentionDays.max).toBe(3650);

    // llmEscalationMin: z.coerce.number().int().min(0).max(100)
    expect(SETTINGS_METADATA.llmEscalationMin.min).toBe(0);
    expect(SETTINGS_METADATA.llmEscalationMin.max).toBe(100);

    // exitConfidenceDropPct: z.coerce.number().int().min(1).max(100)
    expect(SETTINGS_METADATA.exitConfidenceDropPct.min).toBe(1);
    expect(SETTINGS_METADATA.exitConfidenceDropPct.max).toBe(100);

    // polymarketOrderPollTimeoutMs: z.coerce.number().int().min(1000).max(30000)
    expect(SETTINGS_METADATA.polymarketOrderPollTimeoutMs.min).toBe(1000);
    expect(SETTINGS_METADATA.polymarketOrderPollTimeoutMs.max).toBe(30000);

    // polymarketOrderPollIntervalMs: z.coerce.number().int().min(100).max(5000)
    expect(SETTINGS_METADATA.polymarketOrderPollIntervalMs.min).toBe(100);
    expect(SETTINGS_METADATA.polymarketOrderPollIntervalMs.max).toBe(5000);

    // autoUnwindMaxLossPct: z.coerce.number().min(0).max(100)
    expect(SETTINGS_METADATA.autoUnwindMaxLossPct.min).toBe(0);
    expect(SETTINGS_METADATA.autoUnwindMaxLossPct.max).toBe(100);

    // exitTimeDecayTrigger: z.coerce.number().min(0).max(1)
    expect(SETTINGS_METADATA.exitTimeDecayTrigger.min).toBe(0);
    expect(SETTINGS_METADATA.exitTimeDecayTrigger.max).toBe(1);
  });

  it('[P1] each entry has required fields: group, label, description, type, envDefault', () => {
    for (const [key, entry] of Object.entries(SETTINGS_METADATA)) {
      expect(entry, `SETTINGS_METADATA["${key}"] missing group`).toHaveProperty(
        'group',
      );
      expect(entry, `SETTINGS_METADATA["${key}"] missing label`).toHaveProperty(
        'label',
      );
      expect(
        entry,
        `SETTINGS_METADATA["${key}"] missing description`,
      ).toHaveProperty('description');
      expect(entry, `SETTINGS_METADATA["${key}"] missing type`).toHaveProperty(
        'type',
      );
      expect(
        entry,
        `SETTINGS_METADATA["${key}"] missing envDefault`,
      ).toHaveProperty('envDefault');

      // group must be a valid SettingsGroup enum value
      expect(
        Object.values(SettingsGroup) as string[],
        `SETTINGS_METADATA["${key}"].group is not a valid SettingsGroup value`,
      ).toContain(entry.group);

      // label must be a non-empty string
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);

      // description must be a non-empty string
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('[P1] RESETTABLE_SETTINGS_KEYS excludes bankrollUsd', () => {
    expect(RESETTABLE_SETTINGS_KEYS).not.toContain('bankrollUsd');
    expect(RESETTABLE_SETTINGS_KEYS.length).toBe(
      Object.keys(CONFIG_DEFAULTS).length - 1,
    );
  });
});
