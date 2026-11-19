import { describe, it, expect } from 'vitest';
import {
  parseActionableError,
  getVersionedResultUrl,
  getRemovalStageLabel,
  isRemovalActive,
} from './removalUtils';
import { RemovalStage } from '../types/api';

describe('removalUtils', () => {
  describe('parseActionableError', () => {
    it('returns generic error when errorMsg is undefined or empty', () => {
      const err = parseActionableError(undefined);
      expect(err.type).toBe('generic');
      expect(err.title).toBe('Removal Pipeline Error');

      const errEmpty = parseActionableError('');
      expect(errEmpty.type).toBe('generic');
    });

    it('identifies missing weights error', () => {
      const err1 = parseActionableError('Missing required model weights: EffectErase.ckpt');
      expect(err1.type).toBe('weights');
      expect(err1.title).toBe('Missing Model Weights');
      expect(err1.hint).toContain('EFFECT_ERASE_CHECKPOINT_PATH');

      const err2 = parseActionableError('Wan2.1 checkpoint not found');
      expect(err2.type).toBe('weights');
    });

    it('identifies GPU / CUDA errors', () => {
      const err1 = parseActionableError('CUDA out of memory error');
      expect(err1.type).toBe('gpu');
      expect(err1.title).toBe('GPU / CUDA Resource Limit');

      const err2 = parseActionableError('torch.cuda.OutOfMemoryError: OOM on device 0');
      expect(err2.type).toBe('gpu');
    });

    it('identifies missing runtime or python environment', () => {
      const err1 = parseActionableError('Configured Python binary does not exist or is not executable');
      expect(err1.type).toBe('runtime');
      expect(err1.title).toBe('Missing Runtime Environment');

      const err2 = parseActionableError('Command not found: effect_erase');
      expect(err2.type).toBe('runtime');
    });

    it('identifies mask alignment and frame count mismatches', () => {
      const err = parseActionableError('Mask sequence frame count mismatch: found 10, expected 15');
      expect(err.type).toBe('mask_alignment');
      expect(err.title).toBe('Mask Alignment Mismatch');
    });

    it('preserves generic errors with full hint text', () => {
      const customMsg = 'Network socket closed unexpectedly';
      const err = parseActionableError(customMsg);
      expect(err.type).toBe('generic');
      expect(err.hint).toBe(customMsg);
    });
  });

  describe('getVersionedResultUrl', () => {
    it('constructs standard API result url with version query token', () => {
      const url = getVersionedResultUrl('job-123', 'erase-abc');
      expect(url).toBe('/api/v1/jobs/job-123/removal/erase-abc/result?v=erase-abc');
    });

    it('appends version token to custom baseUrl without parameters', () => {
      const url = getVersionedResultUrl('job-123', 'erase-abc', '/custom/cleaned.mp4');
      expect(url).toBe('/custom/cleaned.mp4?v=erase-abc');
    });

    it('appends version token using ampersand when baseUrl has parameters', () => {
      const url = getVersionedResultUrl('job-123', 'erase-abc', '/custom/cleaned.mp4?download=true');
      expect(url).toBe('/custom/cleaned.mp4?download=true&v=erase-abc');
    });

    it('does not duplicate version token if already present', () => {
      const baseUrl = '/api/v1/jobs/job-123/removal/erase-abc/result?v=erase-abc';
      const url = getVersionedResultUrl('job-123', 'erase-abc', baseUrl);
      expect(url).toBe(baseUrl);
    });
  });

  describe('getRemovalStageLabel', () => {
    it('provides friendly labels for all known removal stages', () => {
      const stages: RemovalStage[] = [
        'queued',
        'preparing_input',
        'loading_model',
        'inference',
        'validating_output',
        'publishing',
        'completed',
        'failed',
        'cancelled',
      ];
      stages.forEach((stage) => {
        const label = getRemovalStageLabel(stage);
        expect(label).toBeTruthy();
        expect(typeof label).toBe('string');
      });
    });
  });

  describe('isRemovalActive', () => {
    it('returns false for terminal stages', () => {
      expect(isRemovalActive('completed')).toBe(false);
      expect(isRemovalActive('failed')).toBe(false);
      expect(isRemovalActive('cancelled')).toBe(false);
    });

    it('returns true for in-progress or queued stages', () => {
      expect(isRemovalActive('queued')).toBe(true);
      expect(isRemovalActive('preparing_input')).toBe(true);
      expect(isRemovalActive('loading_model')).toBe(true);
      expect(isRemovalActive('inference')).toBe(true);
      expect(isRemovalActive('validating_output')).toBe(true);
      expect(isRemovalActive('publishing')).toBe(true);
    });
  });
});
