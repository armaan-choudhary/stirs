import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutItem {
  keys: string[];
  description: string;
  category: 'Playback' | 'Editing' | 'Navigation' | 'View';
}

const SHORTCUTS: ShortcutItem[] = [
  // Playback
  { keys: ['Space'], description: 'Play / Pause video', category: 'Playback' },
  { keys: ['←', '→'], description: 'Step back / forward 1 frame', category: 'Playback' },
  { keys: ['Shift', '← / →'], description: 'Step back / forward 10 frames', category: 'Playback' },

  // Editing
  { keys: ['1'], description: 'Lasso Loop tool', category: 'Editing' },
  { keys: ['2'], description: 'Bounding Box tool', category: 'Editing' },
  { keys: ['3'], description: 'Point Prompt tool', category: 'Editing' },
  { keys: ['I'], description: 'Set mode to Include (+)', category: 'Editing' },
  { keys: ['E'], description: 'Set mode to Exclude (-)', category: 'Editing' },
  { keys: ['Ctrl / ⌘', 'Z'], description: 'Undo last stroke on frame', category: 'Editing' },
  { keys: ['Ctrl / ⌘', 'Shift', 'Z'], description: 'Redo undone stroke', category: 'Editing' },

  // Navigation
  { keys: ['['], description: 'Jump to previous keyframe', category: 'Navigation' },
  { keys: [']'], description: 'Jump to next keyframe', category: 'Navigation' },

  // View
  { keys: ['H'], description: 'Peek original video (hold to hide mask)', category: 'View' },
  { keys: ['F'], description: 'Toggle Fullscreen', category: 'View' },
  { keys: ['?'], description: 'Toggle this shortcuts modal', category: 'View' },
  { keys: ['Esc'], description: 'Close modal or cancel drawing', category: 'View' },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const categories = ['Playback', 'Editing', 'Navigation', 'View'] as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden text-neutral-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-lime-500/10 text-lime-400 border border-lime-500/20">
              <Keyboard className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-neutral-100">
                Keyboard Shortcuts
              </h2>
              <p className="text-[11px] text-neutral-400">
                Boost your video annotation speed with hotkeys
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content list */}
        <div className="p-6 max-h-[70vh] overflow-y-auto flex flex-col gap-5">
          {categories.map((cat) => {
            const items = SHORTCUTS.filter((s) => s.category === cat);
            if (items.length === 0) return null;

            return (
              <div key={cat} className="flex flex-col gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 font-semibold">
                  {cat}
                </span>
                <div className="grid grid-cols-1 gap-1.5 bg-neutral-950/60 p-2 rounded-xl border border-neutral-800/60">
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-neutral-800/40 text-xs transition"
                    >
                      <span className="text-neutral-300">{item.description}</span>
                      <div className="flex items-center gap-1 font-mono text-[11px]">
                        {item.keys.map((k, kIdx) => (
                          <kbd
                            key={kIdx}
                            className="px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 shadow-sm"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-800 bg-neutral-950/40 flex items-center justify-between text-[11px] font-mono text-neutral-400">
          <span>Press <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-300">Esc</kbd> anytime to dismiss</span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-lg bg-neutral-100 hover:bg-white text-neutral-950 font-semibold text-xs transition"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
