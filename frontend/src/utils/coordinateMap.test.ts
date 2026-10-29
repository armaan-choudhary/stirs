import { describe, it, expect } from 'vitest';
import {
  getActiveRenderRect,
  canvasToVideoCoord,
  videoToCanvasCoord,
} from './coordinateMap';

describe('coordinateMap', () => {
  describe('getActiveRenderRect', () => {
    it('correctly calculates letterboxed (top/bottom bars) when video is wider than canvas', () => {
      // Canvas 1000x1000 (1:1), Video 1920x1080 (16:9 ~ 1.777)
      // rv = 1.777 > rc = 1.0 => letterbox top/bottom
      const rect = getActiveRenderRect(1000, 1000, 1920, 1080);
      expect(rect.renderWidth).toBe(1000);
      expect(rect.offsetX).toBe(0);
      expect(rect.renderHeight).toBeCloseTo(1000 / (1920 / 1080), 2);
      expect(rect.offsetY).toBeCloseTo((1000 - rect.renderHeight) / 2, 2);
    });

    it('correctly calculates pillarboxed (left/right bars) when video is taller than canvas', () => {
      // Canvas 1920x1080 (16:9 ~ 1.777), Video 1080x1920 (9:16 = 0.5625)
      // rv = 0.5625 <= rc = 1.777 => pillarbox left/right
      const rect = getActiveRenderRect(1920, 1080, 1080, 1920);
      expect(rect.renderHeight).toBe(1080);
      expect(rect.offsetY).toBe(0);
      expect(rect.renderWidth).toBeCloseTo(1080 * (1080 / 1920), 2);
      expect(rect.offsetX).toBeCloseTo((1920 - rect.renderWidth) / 2, 2);
    });

    it('handles exact aspect ratio match', () => {
      const rect = getActiveRenderRect(800, 600, 1600, 1200);
      expect(rect.renderWidth).toBe(800);
      expect(rect.renderHeight).toBe(600);
      expect(rect.offsetX).toBe(0);
      expect(rect.offsetY).toBe(0);
    });

    it('handles zero or invalid dimensions gracefully', () => {
      const rect = getActiveRenderRect(0, 0, 1920, 1080);
      expect(rect.renderWidth).toBe(0);
      expect(rect.renderHeight).toBe(0);
    });
  });

  describe('canvasToVideoCoord', () => {
    it('maps letterboxed canvas coordinates to correct video coordinates', () => {
      // Canvas 1000x1000, Video 1000x500 (2:1).
      // rv = 2.0, rc = 1.0 => letterbox.
      // renderWidth = 1000, renderHeight = 500, offsetX = 0, offsetY = 250.
      const canvasW = 1000;
      const canvasH = 1000;
      const videoW = 1000;
      const videoH = 500;

      // Center of video should be at canvas (500, 500)
      const center = canvasToVideoCoord(500, 500, canvasW, canvasH, videoW, videoH);
      expect(center.x).toBeCloseTo(500, 1);
      expect(center.y).toBeCloseTo(250, 1);

      // Top-left of active render area (0, 250) -> video (0, 0)
      const topLeft = canvasToVideoCoord(0, 250, canvasW, canvasH, videoW, videoH);
      expect(topLeft.x).toBeCloseTo(0, 1);
      expect(topLeft.y).toBeCloseTo(0, 1);

      // Bottom-right of active render area (1000, 750) -> video (999, 499) due to clamp [0, Wv-1]
      const bottomRight = canvasToVideoCoord(1000, 750, canvasW, canvasH, videoW, videoH);
      expect(bottomRight.x).toBe(999);
      expect(bottomRight.y).toBe(499);
    });

    it('clamps coordinates clicked outside the video area (in the letterbox bars)', () => {
      const canvasW = 1000;
      const canvasH = 1000;
      const videoW = 1000;
      const videoH = 500;
      // Active video is y: 250..750.
      // Click at y = 50 (in the top black bar) -> clamped to y = 0
      const outsideTop = canvasToVideoCoord(500, 50, canvasW, canvasH, videoW, videoH);
      expect(outsideTop.y).toBe(0);

      // Click at y = 950 (in the bottom black bar) -> clamped to y = 499
      const outsideBottom = canvasToVideoCoord(500, 950, canvasW, canvasH, videoW, videoH);
      expect(outsideBottom.y).toBe(499);
    });

    it('maps pillarboxed canvas coordinates to correct video coordinates', () => {
      // Canvas 1000x1000, Video 500x1000 (1:2).
      // rv = 0.5, rc = 1.0 => pillarbox.
      // renderWidth = 500, renderHeight = 1000, offsetX = 250, offsetY = 0.
      const canvasW = 1000;
      const canvasH = 1000;
      const videoW = 500;
      const videoH = 1000;

      // Center
      const center = canvasToVideoCoord(500, 500, canvasW, canvasH, videoW, videoH);
      expect(center.x).toBeCloseTo(250, 1);
      expect(center.y).toBeCloseTo(500, 1);

      // Pillarbox clamp left
      const outsideLeft = canvasToVideoCoord(100, 500, canvasW, canvasH, videoW, videoH);
      expect(outsideLeft.x).toBe(0);
      expect(outsideLeft.y).toBeCloseTo(500, 1);

      // Pillarbox clamp right
      const outsideRight = canvasToVideoCoord(900, 500, canvasW, canvasH, videoW, videoH);
      expect(outsideRight.x).toBe(499);
    });
  });

  describe('videoToCanvasCoord & roundtrip', () => {
    it('roundtrips coordinates accurately within active render rectangle', () => {
      const canvasW = 1280;
      const canvasH = 720;
      const videoW = 1920;
      const videoH = 1080;

      const origVideoX = 850;
      const origVideoY = 420;

      const canvasPt = videoToCanvasCoord(origVideoX, origVideoY, canvasW, canvasH, videoW, videoH);
      const backToVideo = canvasToVideoCoord(canvasPt.x, canvasPt.y, canvasW, canvasH, videoW, videoH);

      expect(backToVideo.x).toBeCloseTo(origVideoX, 1);
      expect(backToVideo.y).toBeCloseTo(origVideoY, 1);
    });
  });
});
