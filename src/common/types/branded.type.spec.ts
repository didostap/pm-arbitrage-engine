import { describe, it, expect } from 'vitest';
import {
  asPositionId,
  asOrderId,
  asPairId,
  asMatchId,
  asContractId,
  asOpportunityId,
  asReservationId,
  unwrapId,
} from './branded.type';

describe('Branded Types', () => {
  describe('factory functions', () => {
    it('should create branded IDs from raw strings', () => {
      const positionId = asPositionId('pos-1');
      const orderId = asOrderId('ord-1');
      const pairId = asPairId('pair-1');
      const matchId = asMatchId('match-1');
      const contractId = asContractId('contract-1');
      const opportunityId = asOpportunityId('opp-1');
      const reservationId = asReservationId('res-1');

      // At runtime, branded types ARE plain strings
      expect(typeof positionId).toBe('string');
      expect(typeof orderId).toBe('string');
      expect(typeof pairId).toBe('string');
      expect(typeof matchId).toBe('string');
      expect(typeof contractId).toBe('string');
      expect(typeof opportunityId).toBe('string');
      expect(typeof reservationId).toBe('string');
    });
  });

  describe('unwrapId', () => {
    it('should round-trip branded IDs back to plain strings', () => {
      expect(unwrapId(asPositionId('abc'))).toBe('abc');
      expect(unwrapId(asOrderId('def'))).toBe('def');
      expect(unwrapId(asPairId('ghi'))).toBe('ghi');
      expect(unwrapId(asMatchId('jkl'))).toBe('jkl');
      expect(unwrapId(asContractId('mno'))).toBe('mno');
      expect(unwrapId(asOpportunityId('pqr'))).toBe('pqr');
      expect(unwrapId(asReservationId('stu'))).toBe('stu');
    });

    it('should preserve empty strings', () => {
      expect(unwrapId(asPositionId(''))).toBe('');
    });

    it('should preserve UUID-format strings', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(unwrapId(asPositionId(uuid))).toBe(uuid);
    });
  });

  describe('JSON serialization', () => {
    it('should serialize branded IDs as plain strings in JSON', () => {
      const obj = {
        positionId: asPositionId('pos-1'),
        orderId: asOrderId('ord-1'),
      };

      const json = JSON.stringify(obj);
      const parsed = JSON.parse(json) as Record<string, string>;

      expect(parsed.positionId).toBe('pos-1');
      expect(parsed.orderId).toBe('ord-1');
    });
  });

  describe('compile-time type safety', () => {
    // These tests verify the RUNTIME behavior is correct.
    // Compile-time assignability constraints are enforced by TypeScript:
    // - A PositionId cannot be passed where OrderId is expected
    // - A plain string cannot be passed where a branded ID is expected
    // If these constraints were violated, `pnpm build` would fail.

    it('should be usable as Map keys', () => {
      const map = new Map<string, number>();
      const posId = asPositionId('pos-1');
      map.set(posId, 42);
      expect(map.get(posId)).toBe(42);
    });

    it('should be usable in string interpolation', () => {
      const posId = asPositionId('pos-1');
      expect(`Position: ${posId}`).toBe('Position: pos-1');
    });

    it('should support string comparison', () => {
      const id1 = asPositionId('abc');
      const id2 = asPositionId('abc');

      expect(id1.toString()).toBe(id2.toString());
    });
  });
});
