import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Decimal from 'decimal.js';
import { FinancialMath } from './financial-math';
import { FeeSchedule } from '../types/platform.type';
import { PlatformId } from '../types/platform.type';

interface CsvScenario {
  scenario_name: string;
  buy_price: string;
  sell_price: string;
  buy_fee_pct: string;
  sell_fee_pct: string;
  gas_estimate_usd: string;
  position_size_usd: string;
  expected_gross_edge: string;
  expected_net_edge: string;
  expected_passes_filter: string;
  notes: string;
}

// Minimal CSV parser — handles quoted fields but not escaped quotes ("") or newlines
// within fields. Sufficient for our controlled test data CSV.
function loadCsvScenarios(): CsvScenario[] {
  const csvPath = resolve(
    __dirname,
    '../../modules/arbitrage-detection/__tests__/edge-calculation-scenarios.csv',
  );
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));

  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    // Handle commas inside notes (last field may contain commas)
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);

    const record: Record<string, string> = {};
    header.forEach((h, i) => {
      record[h.trim()] = (parts[i] || '').trim();
    });
    return record as unknown as CsvScenario;
  });
}

function makeFeeSchedule(takerFeePercent: number): FeeSchedule {
  return {
    platformId: PlatformId.KALSHI,
    makerFeePercent: 0,
    takerFeePercent,
    description: 'test fee schedule',
  };
}

const THRESHOLD = new Decimal('0.008'); // 0.80%

describe('FinancialMath', () => {
  const scenarios = loadCsvScenarios();

  describe('CSV scenario validation', () => {
    it('should load at least 15 scenarios', () => {
      expect(scenarios.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('calculateGrossEdge', () => {
    scenarios.forEach((s) => {
      it(`should compute correct gross edge for ${s.scenario_name}`, () => {
        const result = FinancialMath.calculateGrossEdge(
          new Decimal(s.buy_price),
          new Decimal(s.sell_price),
        );
        expect(result.toFixed(20)).toBe(
          new Decimal(s.expected_gross_edge).toFixed(20),
        );
      });
    });
  });

  describe('calculateNetEdge', () => {
    scenarios.forEach((s) => {
      it(`should compute correct net edge for ${s.scenario_name}`, () => {
        const grossEdge = new Decimal(s.expected_gross_edge);
        const result = FinancialMath.calculateNetEdge(
          grossEdge,
          new Decimal(s.buy_price),
          new Decimal(s.sell_price),
          makeFeeSchedule(parseFloat(s.buy_fee_pct)),
          makeFeeSchedule(parseFloat(s.sell_fee_pct)),
          new Decimal(s.gas_estimate_usd),
          new Decimal(s.position_size_usd),
        );
        expect(result.toFixed(20)).toBe(
          new Decimal(s.expected_net_edge).toFixed(20),
        );
      });
    });
  });

  describe('isAboveThreshold', () => {
    scenarios.forEach((s) => {
      it(`should correctly filter ${s.scenario_name}`, () => {
        const netEdge = new Decimal(s.expected_net_edge);
        const result = FinancialMath.isAboveThreshold(netEdge, THRESHOLD);
        const expectedPassesFilter = s.expected_passes_filter === 'true';
        expect(result).toBe(expectedPassesFilter);
      });
    });
  });

  describe('NaN/Infinity guards', () => {
    it('should reject NaN buyPrice in calculateGrossEdge', () => {
      expect(() =>
        FinancialMath.calculateGrossEdge(new Decimal(NaN), new Decimal('0.5')),
      ).toThrowError(/buyPrice must not be NaN/);
    });

    it('should reject Infinity sellPrice in calculateGrossEdge', () => {
      expect(() =>
        FinancialMath.calculateGrossEdge(
          new Decimal('0.5'),
          new Decimal(Infinity),
        ),
      ).toThrowError(/sellPrice must not be Infinity/);
    });

    it('should reject NaN in calculateNetEdge', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal(NaN),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(2.0),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('100'),
        ),
      ).toThrowError(/grossEdge must not be NaN/);
    });

    it('should reject NaN takerFeePercent in calculateNetEdge', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal('0.05'),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(NaN),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('100'),
        ),
      ).toThrowError(/buyFeeSchedule.takerFeePercent must not be NaN/);
    });

    it('should reject zero positionSizeUsd', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal('0.05'),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(2.0),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('0'),
        ),
      ).toThrowError(/positionSizeUsd must not be zero/);
    });

    it('should reject NaN in isAboveThreshold', () => {
      expect(() =>
        FinancialMath.isAboveThreshold(new Decimal(NaN), new Decimal('0.008')),
      ).toThrowError(/netEdge must not be NaN/);
    });
  });
});
