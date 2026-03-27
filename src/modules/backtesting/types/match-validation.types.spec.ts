import { describe, it, expect } from 'vitest';
import type {
  ExternalMatchedPair,
  ValidationReportEntry,
  ValidationReportSummary,
} from './match-validation.types';

describe('ExternalMatchedPair', () => {
  it('[P1] should construct ExternalMatchedPair with OddsPipe source and spread data', () => {
    const pair: ExternalMatchedPair = {
      polymarketId: '0xabc123',
      kalshiId: null,
      polymarketTitle: 'Will Bitcoin exceed $100k?',
      kalshiTitle: 'Bitcoin above $100,000',
      source: 'oddspipe',
      similarity: null,
      spreadData: {
        yesDiff: 0.03,
        polyYesPrice: 0.65,
        kalshiYesPrice: 0.62,
      },
    };

    expect(pair).toEqual(
      expect.objectContaining({
        source: 'oddspipe',
        polymarketTitle: 'Will Bitcoin exceed $100k?',
        kalshiTitle: 'Bitcoin above $100,000',
        spreadData: expect.objectContaining({ yesDiff: 0.03 }),
      }),
    );
  });

  it('[P1] should construct ExternalMatchedPair with Predexon source and null similarity', () => {
    const pair: ExternalMatchedPair = {
      polymarketId: '0xabc123',
      kalshiId: 'KXBTC-24DEC31',
      polymarketTitle: 'Will Bitcoin exceed $100k?',
      kalshiTitle: 'Bitcoin above $100,000',
      source: 'predexon',
      similarity: null,
      spreadData: null,
    };

    expect(pair).toEqual(
      expect.objectContaining({
        source: 'predexon',
        similarity: null,
        spreadData: null,
        kalshiId: 'KXBTC-24DEC31',
      }),
    );
  });
});

describe('ValidationReportEntry', () => {
  it('[P1] should construct ValidationReportEntry with all 4 category values', () => {
    const categories = [
      'confirmed',
      'our-only',
      'external-only',
      'conflict',
    ] as const;

    for (const category of categories) {
      const entry: ValidationReportEntry = {
        category,
        isKnowledgeBaseCandidate: category === 'external-only',
        notes: `Test entry for ${category}`,
      };
      expect(entry.category).toBe(category);
    }
  });

  it('[P1] should require conflictDescription for conflict category entries', () => {
    const conflictEntry: ValidationReportEntry = {
      category: 'conflict',
      isKnowledgeBaseCandidate: false,
      conflictDescription:
        'Our ContractMatch pairs PM-xxx with K-yyy, but Predexon pairs PM-xxx with K-zzz',
      notes: 'Conflict detected',
    };

    expect(conflictEntry.conflictDescription).toBeDefined();
    expect(conflictEntry.conflictDescription).toContain('PM-xxx');
  });
});

describe('ValidationReportSummary', () => {
  it('[P1] should construct ValidationReportSummary with per-source counts', () => {
    const summary: ValidationReportSummary = {
      confirmedCount: 10,
      ourOnlyCount: 5,
      externalOnlyCount: 3,
      conflictCount: 2,
      totalOurMatches: 15,
      totalOddsPipePairs: 12,
      totalPredexonPairs: 8,
      sourcesQueried: ['oddspipe', 'predexon'],
    };

    expect(summary).toEqual(
      expect.objectContaining({
        confirmedCount: 10,
        ourOnlyCount: 5,
        externalOnlyCount: 3,
        conflictCount: 2,
        totalOurMatches: 15,
        totalOddsPipePairs: 12,
        totalPredexonPairs: 8,
        sourcesQueried: ['oddspipe', 'predexon'],
      }),
    );
  });
});
