import React from 'react';
import { getActiveRenderRect } from '../utils/coordinateMap';

interface MaskOverlayProps {
  maskBase64: string | null;
  videoWidth: number;
  videoHeight: number;
  containerWidth: number;
  containerHeight: number;
  opacity?: number;
}

export const MaskOverlay: React.FC<MaskOverlayProps> = ({
  maskBase64,
  videoWidth,
  videoHeight,
  containerWidth,
  containerHeight,
  opacity = 0.55,
}) => {
  if (!maskBase64 || videoWidth <= 0 || videoHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return null;
  }

  const { renderWidth, renderHeight, offsetX, offsetY } = getActiveRenderRect(
    containerWidth,
    containerHeight,
    videoWidth,
    videoHeight
  );

  const imageSrc = maskBase64.startsWith('data:image')
    ? maskBase64
    : `data:image/png;base64,${maskBase64}`;

  return (
    <div
      className="absolute pointer-events-none select-none transition-opacity duration-150"
      style={{
        left: `${offsetX}px`,
        top: `${offsetY}px`,
        width: `${renderWidth}px`,
        height: `${renderHeight}px`,
        opacity,
      }}
    >
      <img
        src={imageSrc}
        alt="Segmentation Mask Overlay"
        className="w-full h-full object-fill pointer-events-none drop-shadow-[0_0_8px_rgba(56,189,248,0.7)]"
      />
    </div>
  );
};
