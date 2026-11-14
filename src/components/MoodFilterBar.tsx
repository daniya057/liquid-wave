// @ts-nocheck
'use client';

import React, { useMemo } from 'react';
import { Track } from '@/lib/instances';
import { MOOD_OPTIONS, MoodType, detectTrackMood } from '@/lib/trackMood';

interface MoodFilterBarProps {
  tracks: Track[];
  selectedMood: MoodType;
  onSelectMood: (mood: MoodType) => void;
}

export function MoodFilterBar({ tracks, selectedMood, onSelectMood }: MoodFilterBarProps) {
  const counts = useMemo(() => {
    const map: Record<MoodType, number> = { all: tracks.length, calm: 0, energetic: 0, sad: 0 };
    for (const t of tracks) {
      map[detectTrackMood(t)] += 1;
    }
    return map;
  }, [tracks]);

  if (!tracks || tracks.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-2 no-scrollbar">
      {MOOD_OPTIONS.map((option) => {
        const count = counts[option.id];
        if (option.id !== 'all' && count === 0) return null;
        const active = selectedMood === option.id;

        return (
          <button
            key={option.id}
            onClick={() => onSelectMood(option.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
              active
                ? 'bg-white text-black shadow-sm'
                : 'bg-white/10 text-white/75 hover:bg-white/20 hover:text-white'
            }`}
          >
            <span>{option.label}</span>
            <span className={`text-[10px] ${active ? 'text-black/60' : 'text-white/40'}`}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}