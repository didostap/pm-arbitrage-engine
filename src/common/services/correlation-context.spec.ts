import { describe, it, expect } from 'vitest';
import { withCorrelationId, getCorrelationId } from './correlation-context';

describe('correlation-context', () => {
  describe('withCorrelationId', () => {
    it('should generate unique UUID v4 for each invocation', async () => {
      let id1: string | undefined;
      let id2: string | undefined;

      await withCorrelationId(async () => {
        id1 = getCorrelationId();
        await Promise.resolve(); // Satisfy async requirement
      });

      await withCorrelationId(async () => {
        id2 = getCorrelationId();
        await Promise.resolve(); // Satisfy async requirement
      });

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);

      // Verify UUID v4 format
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(id1!)).toBe(true);
      expect(uuidRegex.test(id2!)).toBe(true);
    });

    it('should maintain correlation ID across await boundaries', async () => {
      let capturedId1: string | undefined;
      let capturedId2: string | undefined;

      await withCorrelationId(async () => {
        capturedId1 = getCorrelationId();

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));

        capturedId2 = getCorrelationId();
      });

      expect(capturedId1).toBeDefined();
      expect(capturedId2).toBeDefined();
      expect(capturedId1).toBe(capturedId2); // Same ID after await
    });

    it('should maintain separate IDs for nested contexts', async () => {
      let outerId: string | undefined;
      let innerId: string | undefined;

      await withCorrelationId(async () => {
        outerId = getCorrelationId();

        await withCorrelationId(async () => {
          innerId = getCorrelationId();
          await Promise.resolve(); // Satisfy async requirement
        });
      });

      expect(outerId).toBeDefined();
      expect(innerId).toBeDefined();
      expect(outerId).not.toBe(innerId); // Different IDs for nested contexts
    });
  });

  describe('getCorrelationId', () => {
    it('should return correct ID within context', async () => {
      await withCorrelationId(async () => {
        const id = getCorrelationId();
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
        await Promise.resolve(); // Satisfy async requirement
      });
    });

    it('should return undefined outside context', () => {
      const id = getCorrelationId();
      expect(id).toBeUndefined();
    });

    it('should return undefined after context exits', async () => {
      await withCorrelationId(async () => {
        // ID exists here
        expect(getCorrelationId()).toBeDefined();
        await Promise.resolve(); // Satisfy async requirement
      });

      // ID should not exist here
      expect(getCorrelationId()).toBeUndefined();
    });
  });
});
