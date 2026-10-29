import { StrokeInput } from '../types/api';

export interface FrameHistory {
  past: StrokeInput[][];
  future: StrokeInput[][];
}

export type StrokeHistoryMap = Record<number, FrameHistory>;

export const MAX_HISTORY_STEPS = 50;

/**
 * Gets or initializes empty history for a given frame.
 */
export function getFrameHistory(historyMap: StrokeHistoryMap, frameIdx: number): FrameHistory {
  return historyMap[frameIdx] ?? { past: [], future: [] };
}

/**
 * Pushes the current strokes into the past stack, clears the future (redo) stack,
 * and caps the past stack length at maxSteps.
 */
export function recordStrokeAction(
  historyMap: StrokeHistoryMap,
  frameIdx: number,
  previousStrokes: StrokeInput[],
  maxSteps: number = MAX_HISTORY_STEPS
): StrokeHistoryMap {
  const currentHistory = getFrameHistory(historyMap, frameIdx);
  const newPast = [...currentHistory.past, previousStrokes];
  if (newPast.length > maxSteps) {
    newPast.splice(0, newPast.length - maxSteps);
  }

  return {
    ...historyMap,
    [frameIdx]: {
      past: newPast,
      future: [], // New action invalidates redo branch
    },
  };
}

/**
 * Performs an undo operation for a frame:
 * - Pops the previous state from past
 * - Pushes the current state to future (redo stack capped at maxSteps)
 * Returns the updated history map and the new current strokes (or null if cannot undo).
 */
export function performUndo(
  historyMap: StrokeHistoryMap,
  frameIdx: number,
  currentStrokes: StrokeInput[],
  maxSteps: number = MAX_HISTORY_STEPS
): { newHistoryMap: StrokeHistoryMap; restoredStrokes: StrokeInput[] } | null {
  const currentHistory = getFrameHistory(historyMap, frameIdx);
  if (currentHistory.past.length === 0) {
    return null;
  }

  const newPast = [...currentHistory.past];
  const restoredStrokes = newPast.pop()!;

  const newFuture = [...currentHistory.future, currentStrokes];
  if (newFuture.length > maxSteps) {
    newFuture.splice(0, newFuture.length - maxSteps);
  }

  return {
    newHistoryMap: {
      ...historyMap,
      [frameIdx]: {
        past: newPast,
        future: newFuture,
      },
    },
    restoredStrokes,
  };
}

/**
 * Performs a redo operation for a frame:
 * - Pops the state from future
 * - Pushes the current state to past (undo stack capped at maxSteps)
 * Returns the updated history map and the restored strokes (or null if cannot redo).
 */
export function performRedo(
  historyMap: StrokeHistoryMap,
  frameIdx: number,
  currentStrokes: StrokeInput[],
  maxSteps: number = MAX_HISTORY_STEPS
): { newHistoryMap: StrokeHistoryMap; restoredStrokes: StrokeInput[] } | null {
  const currentHistory = getFrameHistory(historyMap, frameIdx);
  if (currentHistory.future.length === 0) {
    return null;
  }

  const newFuture = [...currentHistory.future];
  const restoredStrokes = newFuture.pop()!;

  const newPast = [...currentHistory.past, currentStrokes];
  if (newPast.length > maxSteps) {
    newPast.splice(0, newPast.length - maxSteps);
  }

  return {
    newHistoryMap: {
      ...historyMap,
      [frameIdx]: {
        past: newPast,
        future: newFuture,
      },
    },
    restoredStrokes,
  };
}

/**
 * Checks if undo is possible for the given frame.
 */
export function canUndo(historyMap: StrokeHistoryMap, frameIdx: number): boolean {
  return (historyMap[frameIdx]?.past?.length ?? 0) > 0;
}

/**
 * Checks if redo is possible for the given frame.
 */
export function canRedo(historyMap: StrokeHistoryMap, frameIdx: number): boolean {
  return (historyMap[frameIdx]?.future?.length ?? 0) > 0;
}
