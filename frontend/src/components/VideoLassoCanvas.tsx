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
import { Plus, Minus, Undo2, Redo2, X, CircleDot, Square, Lasso } from 'lucide-react';

export type SelectionTool = 'lasso' | 'box' | 'point';

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
  activeTool?: SelectionTool;
  onToolChange?: (tool: SelectionTool) => void;
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
      activeTool = 'lasso',
      onToolChange,
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
    const [boxStart, setBoxStart] = useState<Point2D | null>(null);
    const [boxCurrent, setBoxCurrent] = useState<Point2D | null>(null);

    useImperativeHandle(ref, () => ({
      clearStrokes: () => {
        onStrokesChange([]);
      },
    }));

    // Repaint all strokes whenever canvas size, strokes or active drawing change
    const redrawCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas || videoWidth <= 0 || videoHeight <= 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      // 1. Draw committed strokes
      strokes.forEach((stroke, strokeIdx) => {
        const isInclude = stroke.mode === 'include';
        const primaryColor = isInclude ? '#06b6d4' : '#f43f5e'; // Cyan for include, Rose for exclude
        const fillColor = isInclude ? 'rgba(6, 182, 212, 0.12)' : 'rgba(244, 63, 94, 0.12)';

        // A: Point prompt (single coordinate)
        if (stroke.points.length === 1) {
          const pt = videoToCanvasCoord(
            stroke.points[0].x,
            stroke.points[0].y,
            width,
            height,
            videoWidth,
            videoHeight
          );

          ctx.save();
          // Glow halo
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2);
          ctx.fillStyle = fillColor;
          ctx.fill();

          // Target circle
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = primaryColor;
          ctx.shadowColor = primaryColor;
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          // Centered symbol (+ / -)
          ctx.font = 'bold 11px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(isInclude ? '+' : '−', pt.x, pt.y);
          ctx.restore();
          return;
        }

        // B: Bounding Box or Lasso Polygon
        if (stroke.points.length < 2) return;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = primaryColor;
        ctx.shadowColor = primaryColor;
        ctx.shadowBlur = 6;

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

        // Close and fill transparently
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.stroke();

        // Stroke index badge near start point
        ctx.beginPath();
        ctx.arc(startCanvasPt.x, startCanvasPt.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = primaryColor;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(strokeIdx + 1), startCanvasPt.x, startCanvasPt.y);

        ctx.restore();
      });

      // 2. Draw active in-progress drawing
      const isInclude = strokeMode === 'include';
      const activeColor = isInclude ? '#06b6d4' : '#f43f5e';

      if (activeTool === 'box' && boxStart && boxCurrent) {
        // Dragging Bounding Box
        const p1 = videoToCanvasCoord(boxStart.x, boxStart.y, width, height, videoWidth, videoHeight);
        const p2 = videoToCanvasCoord(boxCurrent.x, boxCurrent.y, width, height, videoWidth, videoHeight);

        const bx = Math.min(p1.x, p2.x);
        const by = Math.min(p1.y, p2.y);
        const bw = Math.abs(p2.x - p1.x);
        const bh = Math.abs(p2.y - p1.y);

        ctx.save();
        ctx.strokeStyle = activeColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.fillStyle = isInclude ? 'rgba(6, 182, 212, 0.15)' : 'rgba(244, 63, 94, 0.15)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);

        // Corner guides
        const cornerSize = 6;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx - cornerSize / 2, by - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(bx + bw - cornerSize / 2, by - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(bx - cornerSize / 2, by + bh - cornerSize / 2, cornerSize, cornerSize);
        ctx.fillRect(bx + bw - cornerSize / 2, by + bh - cornerSize / 2, cornerSize, cornerSize);

        // Dimension label
        const videoBoxW = Math.round(Math.abs(boxCurrent.x - boxStart.x));
        const videoBoxH = Math.round(Math.abs(boxCurrent.y - boxStart.y));
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(bx, Math.max(0, by - 18), 80, 16);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${videoBoxW} × ${videoBoxH}`, bx + 4, Math.max(12, by - 6));
        ctx.restore();
      } else if (activeStroke.length >= 2) {
        // Dragging Lasso Loop
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = activeColor;
        ctx.shadowColor = activeColor;
        ctx.shadowBlur = 8;

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
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineTo(startPt.x, startPt.y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }, [strokes, activeStroke, boxStart, boxCurrent, strokeMode, activeTool, videoWidth, videoHeight]);

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

      // Auto-pause video when interacting with canvas
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

      if (activeTool === 'point') {
        // Point prompt: immediate single-click commitment
        const newStroke: StrokeInput = {
          points: [videoCoord],
          mode: strokeMode,
        };
        const updated = [...strokes, newStroke];
        onStrokesChange(updated);
        onStrokeCompleted(updated);
        setIsDrawing(false);
      } else if (activeTool === 'box') {
        setBoxStart(videoCoord);
        setBoxCurrent(videoCoord);
      } else {
        // Lasso tool
        setActiveStroke([videoCoord]);
      }
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

      if (activeTool === 'box') {
        setBoxCurrent(videoCoord);
      } else if (activeTool === 'lasso') {
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
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || disabled) return;
      const canvas = canvasRef.current;
      if (canvas && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }

      setIsDrawing(false);

      if (activeTool === 'box' && boxStart && boxCurrent) {
        const x1 = Math.min(boxStart.x, boxCurrent.x);
        const y1 = Math.min(boxStart.y, boxCurrent.y);
        const x2 = Math.max(boxStart.x, boxCurrent.x);
        const y2 = Math.max(boxStart.y, boxCurrent.y);

        // Ensure minimum box size (> 4x4 pixels)
        if (Math.abs(x2 - x1) >= 4 && Math.abs(y2 - y1) >= 4) {
          const boxPoints: Point2D[] = [
            { x: x1, y: y1 },
            { x: x2, y: y1 },
            { x: x2, y: y2 },
            { x: x1, y: y2 },
            { x: x1, y: y1 },
          ];
          const newStroke: StrokeInput = {
            points: boxPoints,
            mode: strokeMode,
          };
          const updated = [...strokes, newStroke];
          onStrokesChange(updated);
          onStrokeCompleted(updated);
        }
        setBoxStart(null);
        setBoxCurrent(null);
      } else if (activeTool === 'lasso') {
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
      }
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

        {/* Floating Canvas Quick Controls (Top-Left Pill) */}
        <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-auto z-20">
          {/* Tool selector */}
          <div className="flex items-center bg-neutral-950/90 backdrop-blur border border-neutral-800 rounded-lg p-1 shadow-lg">
            <button
              type="button"
              onClick={() => onToolChange?.('lasso')}
              title="Lasso Loop Tool (1)"
              className={`p-1.5 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                activeTool === 'lasso'
                  ? 'bg-neutral-100 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <Lasso className="w-3.5 h-3.5" />
              <span>Lasso</span>
            </button>

            <button
              type="button"
              onClick={() => onToolChange?.('box')}
              title="Bounding Box Tool (2)"
              className={`p-1.5 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                activeTool === 'box'
                  ? 'bg-neutral-100 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <Square className="w-3.5 h-3.5" />
              <span>Box</span>
            </button>

            <button
              type="button"
              onClick={() => onToolChange?.('point')}
              title="Point Prompt Tool (3)"
              className={`p-1.5 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                activeTool === 'point'
                  ? 'bg-neutral-100 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <CircleDot className="w-3.5 h-3.5" />
              <span>Point</span>
            </button>
          </div>

          {/* Mode selector (Include / Exclude) */}
          <div className="flex items-center bg-neutral-950/90 backdrop-blur border border-neutral-800 rounded-lg p-1 shadow-lg">
            <button
              type="button"
              onClick={() => onStrokeModeChange('include')}
              title="Include Prompt (+ / I)"
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                strokeMode === 'include'
                  ? 'bg-cyan-500 text-neutral-950 font-bold shadow-sm'
                  : 'text-neutral-400 hover:text-cyan-400 hover:bg-neutral-900'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Include</span>
            </button>

            <button
              type="button"
              onClick={() => onStrokeModeChange('exclude')}
              title="Exclude Prompt (- / E)"
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition ${
                strokeMode === 'exclude'
                  ? 'bg-rose-500 text-white font-bold shadow-sm'
                  : 'text-neutral-400 hover:text-rose-400 hover:bg-neutral-900'
              }`}
            >
              <Minus className="w-3.5 h-3.5" />
              <span>Exclude</span>
            </button>
          </div>

          {/* Undo / Redo / Clear */}
          <div className="flex items-center gap-0.5 bg-neutral-950/90 backdrop-blur border border-neutral-800 rounded-lg p-1 shadow-lg">
            <button
              type="button"
              onClick={handleUndo}
              disabled={disabled || (!canUndo && strokes.length === 0)}
              title="Undo stroke (Ctrl+Z / ⌘Z)"
              className="p-1.5 rounded-md text-xs text-neutral-400 hover:text-white hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={disabled || !canRedo}
              title="Redo stroke (Ctrl+Shift+Z / ⌘⇧Z)"
              className="p-1.5 rounded-md text-xs text-neutral-400 hover:text-white hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            {strokes.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                disabled={disabled}
                title="Clear all strokes on frame"
                className="p-1.5 rounded-md text-xs text-neutral-400 hover:text-rose-400 hover:bg-neutral-900 transition flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);
