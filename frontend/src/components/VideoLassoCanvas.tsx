import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Point2D, StrokeInput, StrokeMode } from '../types/api';
import { canvasToVideoCoord, videoToCanvasCoord } from '../utils/coordinateMap';
import { Plus, Minus, Undo2, Redo2, X } from 'lucide-react';

export interface VideoLassoCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  videoWidth: number;
  videoHeight: number;
  currentFrameIdx: number;
  strokes: StrokeInput[];
  onStrokesChange: (strokes: StrokeInput[]) => void;
  onStrokeCompleted: (strokes: StrokeInput[]) => void;
  strokeMode: StrokeMode;
  onStrokeModeChange: (mode: StrokeMode) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onClearAll?: () => void;
  disabled?: boolean;
}

export interface VideoLassoCanvasHandle {
  clearStrokes: () => void;
}

export const VideoLassoCanvas = forwardRef<VideoLassoCanvasHandle, VideoLassoCanvasProps>(
  (
    {
      videoRef,
      videoWidth,
      videoHeight,
      currentFrameIdx: _currentFrameIdx,
      strokes,
      onStrokesChange,
      onStrokeCompleted,
      strokeMode,
      onStrokeModeChange,
      canUndo = false,
      canRedo = false,
      onUndo,
      onRedo,
      onClearAll,
      disabled = false,
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [activeStroke, setActiveStroke] = useState<Point2D[]>([]);

    useImperativeHandle(ref, () => ({
      clearStrokes: () => {
        onStrokesChange([]);
      },
    }));

    // Repaint all strokes whenever canvas size, strokes or active stroke change
    const redrawCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas || videoWidth <= 0 || videoHeight <= 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      // Draw committed strokes (monochromatic clean styling)
      strokes.forEach((stroke) => {
        if (stroke.points.length < 2) return;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;

        const isInclude = stroke.mode === 'include';
        ctx.strokeStyle = isInclude ? '#ffffff' : '#71717a';
        ctx.shadowColor = isInclude ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;

        ctx.beginPath();
        const startCanvasPt = videoToCanvasCoord(
          stroke.points[0].x,
          stroke.points[0].y,
          width,
          height,
          videoWidth,
          videoHeight
        );
        ctx.moveTo(startCanvasPt.x, startCanvasPt.y);

        for (let i = 1; i < stroke.points.length; i++) {
          const pt = videoToCanvasCoord(
            stroke.points[i].x,
            stroke.points[i].y,
            width,
            height,
            videoWidth,
            videoHeight
          );
          ctx.lineTo(pt.x, pt.y);
        }

        // Draw clean dashed closing chord
        ctx.stroke();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isInclude ? 'rgba(255, 255, 255, 0.5)' : 'rgba(113, 113, 122, 0.5)';
        ctx.lineTo(startCanvasPt.x, startCanvasPt.y);
        ctx.stroke();
        ctx.restore();
      });

      // Draw currently active drawing stroke
      if (activeStroke.length >= 2) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;

        const isInclude = strokeMode === 'include';
        ctx.strokeStyle = isInclude ? '#ffffff' : '#a1a1aa';
        ctx.shadowColor = isInclude ? 'rgba(255, 255, 255, 0.6)' : 'rgba(161, 161, 170, 0.4)';
        ctx.shadowBlur = 6;

        ctx.beginPath();
        const startPt = videoToCanvasCoord(
          activeStroke[0].x,
          activeStroke[0].y,
          width,
          height,
          videoWidth,
          videoHeight
        );
        ctx.moveTo(startPt.x, startPt.y);

        for (let i = 1; i < activeStroke.length; i++) {
          const pt = videoToCanvasCoord(
            activeStroke[i].x,
            activeStroke[i].y,
            width,
            height,
            videoWidth,
            videoHeight
          );
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();

        // Guide line connecting cursor to origin
        if (activeStroke.length > 5) {
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.lineTo(startPt.x, startPt.y);
          ctx.stroke();
        }

        ctx.restore();
      }
    }, [strokes, activeStroke, strokeMode, videoWidth, videoHeight]);

    // Resize canvas buffer to match its bounding client rect
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const updateDimensions = () => {
        const rect = canvas.getBoundingClientRect();
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
          canvas.width = rect.width;
          canvas.height = rect.height;
          redrawCanvas();
        }
      };

      updateDimensions();
      const observer = new ResizeObserver(updateDimensions);
      observer.observe(canvas);

      return () => observer.disconnect();
    }, [redrawCanvas]);

    useEffect(() => {
      redrawCanvas();
    }, [redrawCanvas]);

    // Pointer Event Handlers
    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.setPointerCapture(e.pointerId);

      // Auto-pause video when starting drawing
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }

      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      const videoCoord = canvasToVideoCoord(
        clientX,
        clientY,
        canvas.width,
        canvas.height,
        videoWidth,
        videoHeight
      );

      setIsDrawing(true);
      setActiveStroke([videoCoord]);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || disabled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      const videoCoord = canvasToVideoCoord(
        clientX,
        clientY,
        canvas.width,
        canvas.height,
        videoWidth,
        videoHeight
      );

      // Distance threshold to avoid duplicate dense points
      setActiveStroke((prev) => {
        if (prev.length === 0) return [videoCoord];
        const last = prev[prev.length - 1];
        const dx = videoCoord.x - last.x;
        const dy = videoCoord.y - last.y;
        if (dx * dx + dy * dy >= 4) {
          return [...prev, videoCoord];
        }
        return prev;
      });
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || disabled) return;
      const canvas = canvasRef.current;
      if (canvas && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }

      setIsDrawing(false);

      if (activeStroke.length >= 3) {
        const newStroke: StrokeInput = {
          points: activeStroke,
          mode: strokeMode,
        };
        const updated = [...strokes, newStroke];
        onStrokesChange(updated);
        onStrokeCompleted(updated);
      }
      setActiveStroke([]);
    };

    const handleUndo = () => {
      if (onUndo) {
        onUndo();
      } else if (strokes.length > 0) {
        const updated = strokes.slice(0, -1);
        onStrokesChange(updated);
        onStrokeCompleted(updated);
      }
    };

    const handleRedo = () => {
      if (onRedo) {
        onRedo();
      }
    };

    const handleClearAll = () => {
      if (onClearAll) {
        onClearAll();
      } else {
        onStrokesChange([]);
        onStrokeCompleted([]);
      }
    };

    return (
      <div className="absolute inset-0 pointer-events-none select-none z-10">
        {/* Drawing Canvas */}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`w-full h-full block ${
            disabled ? 'pointer-events-none cursor-default' : 'pointer-events-auto cursor-crosshair'
          }`}
          style={{ touchAction: 'none' }}
        />

        {/* Minimal Floating Toolbar Pills */}
        <div className="absolute top-3 left-3 flex items-center gap-1.5 pointer-events-auto z-20">
          <div className="flex items-center bg-neutral-950/90 backdrop-blur border border-neutral-800 rounded-md p-0.5 shadow-sm">
            <button
              type="button"
              onClick={() => onStrokeModeChange('include')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${
                strokeMode === 'include'
                  ? 'bg-neutral-100 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Plus className="w-3 h-3" />
              <span>Include</span>
            </button>

            <button
              type="button"
              onClick={() => onStrokeModeChange('exclude')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${
                strokeMode === 'exclude'
                  ? 'bg-neutral-100 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Minus className="w-3 h-3" />
              <span>Exclude</span>
            </button>
          </div>

          <div className="flex items-center gap-1 bg-neutral-950/90 backdrop-blur border border-neutral-800 rounded-md p-0.5 shadow-sm">
            <button
              type="button"
              onClick={handleUndo}
              disabled={disabled || (!canUndo && strokes.length === 0)}
              title="Undo stroke (Ctrl+Z / ⌘Z)"
              aria-label="Undo stroke"
              className="p-1 px-2 rounded text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="w-3 h-3" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={disabled || !canRedo}
              title="Redo stroke (Ctrl+Shift+Z / ⌘⇧Z / Ctrl+Y)"
              aria-label="Redo stroke"
              className="p-1 px-2 rounded text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Redo2 className="w-3 h-3" />
              <span>Redo</span>
            </button>
            {strokes.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                disabled={disabled}
                title="Clear all strokes"
                aria-label="Clear all strokes"
                className="p-1 px-2 rounded text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
              >
                <X className="w-3 h-3" />
                <span>Clear</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);
