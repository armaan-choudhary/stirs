import { describe, it, expect } from 'vitest';
import {
  StrokeHistoryMap,
  recordStrokeAction,
  performUndo,
  performRedo,
  canUndo,
  canRedo,
  getFrameHistory,
  MAX_HISTORY_STEPS,
} from './strokeHistory';
import { StrokeInput } from '../types/api';

const strokeA: StrokeInput = {
  points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }],
  mode: 'include',
};

const strokeB: StrokeInput = {
  points: [{ x: 50, y: 50 }, { x: 60, y: 60 }, { x: 70, y: 70 }],
  mode: 'exclude',
};

const strokeC: StrokeInput = {
  points: [{ x: 80, y: 80 }, { x: 90, y: 90 }, { x: 100, y: 100 }],
  mode: 'include',
};

const strokeD: StrokeInput = {
  points: [{ x: 110, y: 110 }],
  mode: 'exclude',
};

describe('strokeHistory', () => {
  it('records a stroke action, pushes previous strokes to past, and clears future', () => {
    let history: StrokeHistoryMap = {};
    const frame = 0;

    expect(canUndo(history, frame)).toBe(false);
    expect(canRedo(history, frame)).toBe(false);

    // Initial state: empty strokes, user draws strokeA
    history = recordStrokeAction(history, frame, []);
    expect(canUndo(history, frame)).toBe(true);
    expect(canRedo(history, frame)).toBe(false);
    expect(history[frame].past).toEqual([[]]);
  });

  it('performs undo and redo cycles accurately', () => {
    let history: StrokeHistoryMap = {};
    const frame = 5;

    // 1. Initial empty -> Add strokeA
    history = recordStrokeAction(history, frame, []);
    let currentStrokes = [strokeA];

    // 2. Add strokeB
    history = recordStrokeAction(history, frame, currentStrokes);
    currentStrokes = [strokeA, strokeB];

    expect(canUndo(history, frame)).toBe(true);
    expect(canRedo(history, frame)).toBe(false);
    expect(history[frame].past.length).toBe(2);

    // 3. Undo: should restore [strokeA]
    const undo1 = performUndo(history, frame, currentStrokes);
    expect(undo1).not.toBeNull();
    history = undo1!.newHistoryMap;
    currentStrokes = undo1!.restoredStrokes;
    expect(currentStrokes).toEqual([strokeA]);
    expect(canUndo(history, frame)).toBe(true);
    expect(canRedo(history, frame)).toBe(true);

    // 4. Undo again: should restore []
    const undo2 = performUndo(history, frame, currentStrokes);
    expect(undo2).not.toBeNull();
    history = undo2!.newHistoryMap;
    currentStrokes = undo2!.restoredStrokes;
    expect(currentStrokes).toEqual([]);
    expect(canUndo(history, frame)).toBe(false);
    expect(canRedo(history, frame)).toBe(true);

    // 5. Redo: should restore [strokeA]
    const redo1 = performRedo(history, frame, currentStrokes);
    expect(redo1).not.toBeNull();
    history = redo1!.newHistoryMap;
    currentStrokes = redo1!.restoredStrokes;
    expect(currentStrokes).toEqual([strokeA]);
    expect(canUndo(history, frame)).toBe(true);
    expect(canRedo(history, frame)).toBe(true);

    // 6. Redo again: should restore [strokeA, strokeB]
    const redo2 = performRedo(history, frame, currentStrokes);
    expect(redo2).not.toBeNull();
    history = redo2!.newHistoryMap;
    currentStrokes = redo2!.restoredStrokes;
    expect(currentStrokes).toEqual([strokeA, strokeB]);
    expect(canUndo(history, frame)).toBe(true);
    expect(canRedo(history, frame)).toBe(false);
  });

  it('invalidates redo stack when a new stroke is added after undo', () => {
    let history: StrokeHistoryMap = {};
    const frame = 1;

    // Draw strokeA
    history = recordStrokeAction(history, frame, []);
    let currentStrokes = [strokeA];

    // Undo back to empty
    const undoRes = performUndo(history, frame, currentStrokes);
    history = undoRes!.newHistoryMap;
    currentStrokes = undoRes!.restoredStrokes;
    expect(currentStrokes).toEqual([]);
    expect(canRedo(history, frame)).toBe(true);

    // Now draw strokeC instead of redoing strokeA
    history = recordStrokeAction(history, frame, currentStrokes);
    currentStrokes = [strokeC];

    // Redo branch should now be cleared
    expect(canRedo(history, frame)).toBe(false);
    expect(history[frame].future).toEqual([]);
    expect(canUndo(history, frame)).toBe(true);
  });

  it('scopes history per frame independently so frame switching preserves stacks', () => {
    let history: StrokeHistoryMap = {};
    const frame0 = 0;
    const frame10 = 10;

    // Frame 0: draw strokeA
    history = recordStrokeAction(history, frame0, []);
    // Frame 10: draw strokeB then undo it
    history = recordStrokeAction(history, frame10, []);
    const undoF10 = performUndo(history, frame10, [strokeB]);
    history = undoF10!.newHistoryMap;

    // Frame 0 should have 1 undo and 0 redo
    expect(canUndo(history, frame0)).toBe(true);
    expect(canRedo(history, frame0)).toBe(false);

    // Frame 10 should have 0 undo and 1 redo
    expect(canUndo(history, frame10)).toBe(false);
    expect(canRedo(history, frame10)).toBe(true);
  });

  it('caps history stack to MAX_HISTORY_STEPS', () => {
    let history: StrokeHistoryMap = {};
    const frame = 0;
    const cap = 5;

    for (let i = 0; i < 10; i++) {
      history = recordStrokeAction(history, frame, [strokeA], cap);
    }

    expect(history[frame].past.length).toBe(cap);
    expect(MAX_HISTORY_STEPS).toBe(50);
  });

  it('supports undoing a clear operation', () => {
    let history: StrokeHistoryMap = {};
    const frame = 2;

    // User drew strokes A and B
    history = recordStrokeAction(history, frame, []);
    history = recordStrokeAction(history, frame, [strokeA]);
    let currentStrokes = [strokeA, strokeB];

    // User clears all strokes
    history = recordStrokeAction(history, frame, currentStrokes);
    currentStrokes = [];

    expect(canUndo(history, frame)).toBe(true);

    // User undos the clear
    const undoClear = performUndo(history, frame, currentStrokes);
    expect(undoClear).not.toBeNull();
    expect(undoClear!.restoredStrokes).toEqual([strokeA, strokeB]);
  });

  it('handles null returns on boundary conditions (undo empty past, redo empty future)', () => {
    const emptyHistory: StrokeHistoryMap = {};
    const uninitializedFrame = 99;

    expect(canUndo(emptyHistory, uninitializedFrame)).toBe(false);
    expect(canRedo(emptyHistory, uninitializedFrame)).toBe(false);
    expect(performUndo(emptyHistory, uninitializedFrame, [])).toBeNull();
    expect(performRedo(emptyHistory, uninitializedFrame, [])).toBeNull();

    const initializedEmpty: StrokeHistoryMap = {
      [uninitializedFrame]: { past: [], future: [] },
    };
    expect(performUndo(initializedEmpty, uninitializedFrame, [strokeA])).toBeNull();
    expect(performRedo(initializedEmpty, uninitializedFrame, [strokeA])).toBeNull();
  });

  it('getFrameHistory returns empty past and future for non-existent frames', () => {
    const history: StrokeHistoryMap = {};
    const frameHistory = getFrameHistory(history, 42);
    expect(frameHistory).toEqual({ past: [], future: [] });
  });

  it('correctly handles switching between partial redo and adding a new stroke', () => {
    let history: StrokeHistoryMap = {};
    const frame = 3;

    // Draw A, B, C sequentially
    history = recordStrokeAction(history, frame, []); // past: [[]]
    history = recordStrokeAction(history, frame, [strokeA]); // past: [[], [A]]
    history = recordStrokeAction(history, frame, [strokeA, strokeB]); // past: [[], [A], [A, B]]
    let current = [strokeA, strokeB, strokeC];

    // Undo twice -> restored to [strokeA]
    let undoRes = performUndo(history, frame, current);
    history = undoRes!.newHistoryMap;
    current = undoRes!.restoredStrokes; // [strokeA, strokeB]

    undoRes = performUndo(history, frame, current);
    history = undoRes!.newHistoryMap;
    current = undoRes!.restoredStrokes; // [strokeA]
    expect(current).toEqual([strokeA]);
    expect(canRedo(history, frame)).toBe(true);
    expect(history[frame].future.length).toBe(2);

    // Redo once -> restored to [strokeA, strokeB]
    const redoRes = performRedo(history, frame, current);
    history = redoRes!.newHistoryMap;
    current = redoRes!.restoredStrokes; // [strokeA, strokeB]
    expect(current).toEqual([strokeA, strokeB]);
    expect(canRedo(history, frame)).toBe(true);
    expect(history[frame].future.length).toBe(1);

    // Instead of redoing again to [strokeA, strokeB, strokeC], add strokeD
    history = recordStrokeAction(history, frame, current);
    current = [strokeA, strokeB, strokeD];

    // Future (redo) must be completely wiped
    expect(canRedo(history, frame)).toBe(false);
    expect(history[frame].future).toEqual([]);
    expect(canUndo(history, frame)).toBe(true);

    // Undoing now restores [strokeA, strokeB]
    const undoAfterNew = performUndo(history, frame, current);
    expect(undoAfterNew!.restoredStrokes).toEqual([strokeA, strokeB]);
  });

  it('prunes future stack when performing undos beyond maxSteps', () => {
    let history: StrokeHistoryMap = {};
    const frame = 4;
    const maxSteps = 2;

    // Add 4 states
    history = recordStrokeAction(history, frame, [], 10);
    history = recordStrokeAction(history, frame, [strokeA], 10);
    history = recordStrokeAction(history, frame, [strokeA, strokeB], 10);
    history = recordStrokeAction(history, frame, [strokeA, strokeB, strokeC], 10);
    let current = [strokeA, strokeB, strokeC, strokeD];

    // Perform multiple undos with maxSteps=2 for future stack capping
    let undoRes = performUndo(history, frame, current, maxSteps);
    history = undoRes!.newHistoryMap;
    current = undoRes!.restoredStrokes;
    expect(history[frame].future.length).toBe(1);

    undoRes = performUndo(history, frame, current, maxSteps);
    history = undoRes!.newHistoryMap;
    current = undoRes!.restoredStrokes;
    expect(history[frame].future.length).toBe(2);

    undoRes = performUndo(history, frame, current, maxSteps);
    history = undoRes!.newHistoryMap;
    current = undoRes!.restoredStrokes;
    // Future stack should be capped at maxSteps=2
    expect(history[frame].future.length).toBe(maxSteps);
  });

  it('prunes past stack when performing redos beyond maxSteps', () => {
    let history: StrokeHistoryMap = {};
    const frame = 7;
    const maxSteps = 2;

    // Build history and then undo all to fill future stack
    history = recordStrokeAction(history, frame, [], 10);
    history = recordStrokeAction(history, frame, [strokeA], 10);
    history = recordStrokeAction(history, frame, [strokeA, strokeB], 10);
    let current = [strokeA, strokeB, strokeC];

    let u1 = performUndo(history, frame, current, 10);
    history = u1!.newHistoryMap;
    current = u1!.restoredStrokes;

    let u2 = performUndo(history, frame, current, 10);
    history = u2!.newHistoryMap;
    current = u2!.restoredStrokes;

    let u3 = performUndo(history, frame, current, 10);
    history = u3!.newHistoryMap;
    current = u3!.restoredStrokes;

    // Redo repeatedly with maxSteps=2 for past stack capping
    let r1 = performRedo(history, frame, current, maxSteps);
    history = r1!.newHistoryMap;
    current = r1!.restoredStrokes;

    let r2 = performRedo(history, frame, current, maxSteps);
    history = r2!.newHistoryMap;
    current = r2!.restoredStrokes;

    let r3 = performRedo(history, frame, current, maxSteps);
    history = r3!.newHistoryMap;
    current = r3!.restoredStrokes;

    // Past stack should be capped at maxSteps=2
    expect(history[frame].past.length).toBe(maxSteps);
  });

  it('supports full clear -> undo clear -> redo clear sequence', () => {
    let history: StrokeHistoryMap = {};
    const frame = 8;
    let current = [strokeA, strokeB];

    // User actions
    history = recordStrokeAction(history, frame, []);
    history = recordStrokeAction(history, frame, [strokeA]);

    // Clear strokes
    history = recordStrokeAction(history, frame, current);
    current = [];

    // Undo the clear
    const undoClear = performUndo(history, frame, current);
    expect(undoClear).not.toBeNull();
    history = undoClear!.newHistoryMap;
    current = undoClear!.restoredStrokes;
    expect(current).toEqual([strokeA, strokeB]);

    // Redo the clear
    const redoClear = performRedo(history, frame, current);
    expect(redoClear).not.toBeNull();
    history = redoClear!.newHistoryMap;
    current = redoClear!.restoredStrokes;
    expect(current).toEqual([]);
  });
});
