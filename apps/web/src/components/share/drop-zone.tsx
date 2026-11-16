'use client';

import { useState } from 'react';

/**
 * The dashed box a file can be dragged onto (a story's video or audio file, and its picture; Joel,
 * 2026-11-14). It highlights while a file is dragged over it and hands on the first file dropped,
 * as the chooser inside it does: what's dropped goes through the same checks as what's chosen.
 * The chooser stays the accessible way in (keyboard, screen readers); dropping is extra.
 */
export function DropZone({
  onFile,
  children,
}: {
  /** The first file dropped (undefined when what was dropped held no file). */
  onFile: (file: File | undefined) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 text-center ${
        over ? 'border-teal bg-accent' : 'border-border-hover'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFile(e.dataTransfer.files?.[0]);
      }}
      data-drop-zone=""
    >
      {children}
    </div>
  );
}
