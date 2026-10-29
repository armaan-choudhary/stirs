import { Point2D } from '../types/api';

export interface ActiveRenderRect {
  renderWidth: number;
  renderHeight: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Calculates the active video rendering rectangle within a canvas/container
 * when using letterboxing / pillarboxing (CSS object-fit: contain).
 *
 * @param canvasWidth Bounding width of the canvas (Wc)
 * @param canvasHeight Bounding height of the canvas (Hc)
 * @param videoWidth Intrinsic video width (Wv)
 * @param videoHeight Intrinsic video height (Hv)
 */
export function getActiveRenderRect(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number
): ActiveRenderRect {
  if (canvasWidth <= 0 || canvasHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return { renderWidth: 0, renderHeight: 0, offsetX: 0, offsetY: 0 };
  }

  const rc = canvasWidth / canvasHeight;
  const rv = videoWidth / videoHeight;

  let renderWidth: number;
  let renderHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (rv > rc) {
    // Letterboxed top and bottom (video is wider than canvas aspect ratio)
    renderWidth = canvasWidth;
    renderHeight = canvasWidth / rv;
    offsetX = 0;
    offsetY = (canvasHeight - renderHeight) / 2;
  } else {
    // Pillarboxed left and right (video is taller than canvas aspect ratio or equal)
    renderHeight = canvasHeight;
    renderWidth = canvasHeight * rv;
    offsetY = 0;
    offsetX = (canvasWidth - renderWidth) / 2;
  }

  return { renderWidth, renderHeight, offsetX, offsetY };
}

/**
 * Maps raw canvas coordinate (xCanvas, yCanvas) to intrinsic video pixel coordinate (xVideo, yVideo).
 * Enforces clamping within [0, videoWidth - 1] and [0, videoHeight - 1].
 *
 * @param xCanvas Mouse / pointer X relative to canvas top-left
 * @param yCanvas Mouse / pointer Y relative to canvas top-left
 * @param canvasWidth Bounding width of canvas element
 * @param canvasHeight Bounding height of canvas element
 * @param videoWidth Intrinsic video width
 * @param videoHeight Intrinsic video height
 */
export function canvasToVideoCoord(
  xCanvas: number,
  yCanvas: number,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number
): Point2D {
  const { renderWidth, renderHeight, offsetX, offsetY } = getActiveRenderRect(
    canvasWidth,
    canvasHeight,
    videoWidth,
    videoHeight
  );

  if (renderWidth <= 0 || renderHeight <= 0) {
    return { x: 0, y: 0 };
  }

  const rawX = ((xCanvas - offsetX) / renderWidth) * videoWidth;
  const rawY = ((yCanvas - offsetY) / renderHeight) * videoHeight;

  const clampedX = Math.min(Math.max(rawX, 0), videoWidth - 1);
  const clampedY = Math.min(Math.max(rawY, 0), videoHeight - 1);

  return {
    x: clampedX,
    y: clampedY,
  };
}

/**
 * Inverse mapping: maps intrinsic video pixel coordinate (xVideo, yVideo)
 * back to canvas coordinate (xCanvas, yCanvas).
 */
export function videoToCanvasCoord(
  xVideo: number,
  yVideo: number,
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number
): Point2D {
  const { renderWidth, renderHeight, offsetX, offsetY } = getActiveRenderRect(
    canvasWidth,
    canvasHeight,
    videoWidth,
    videoHeight
  );

  if (videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0 };
  }

  const xCanvas = offsetX + (xVideo / videoWidth) * renderWidth;
  const yCanvas = offsetY + (yVideo / videoHeight) * renderHeight;

  return {
    x: xCanvas,
    y: yCanvas,
  };
}
