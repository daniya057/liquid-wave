'use client';

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2 } from 'lucide-react';
import { LyricLine } from '@/hooks/useLyrics';
import { EQ_FREQUENCIES, EQ_PRESETS } from '@/hooks/useAudioEngine';

interface BottomDrawersProps {
  activeDrawer: 'lyrics' | 'eq' | 'sleep' | null;
  onClose: () => void;
  lyricsLines: LyricLine[];
  plainLyrics: string;
  activeLyricIndex: number;
  lyricsLoading: boolean;
  eqGains: number[];
  activePreset: string;
  onUpdateBandGain: (index: number, gain: number) => void;
  onApplyPreset: (preset: string) => void;
  sleepSecondsLeft: number | null;
  onStartSleep: (minutes: number) => void;
  onCancelSleep: () => void;
}

export function BottomDrawers({
  activeDrawer,
  onClose,
  lyricsLines,
  plainLyrics,
  activeLyricIndex,
  lyricsLoading,
  eqGains,
  activePreset,
  onUpdateBandGain,
  onApplyPreset,
  sleepSecondsLeft,
  onStartSleep,
  onCancelSleep,
}: BottomDrawersProps) {
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (activeDrawer === 'lyrics' && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeLyricIndex, activeDrawer]);

  return (
    <AnimatePresence>
      {activeDrawer && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          />

          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 max-w-2xl mx-auto rounded-t-3xl bg-[#111115] border-t border-x border-white/15 p-6 max-h-[80vh] flex flex-col shadow-2xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-white">
                {activeDrawer === 'lyrics' && 'Текст песни'}
                {activeDrawer === 'eq' && '10-полосный эквалайзер'}
                {activeDrawer === 'sleep' && 'Таймер сна'}
              </h3>
              <button
                onClick={onClose}
                className="p-2 rounded-full bg-white/[0.06] hover:bg-white/15 text-white/70 hover:text-white transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {activeDrawer === 'lyrics' && (
              <div className="overflow-y-auto pr-2 space-y-3 flex-1 min-h-[240px]">
                {lyricsLoading ? (
                  <div className="flex items-center justify-center h-48 text-white/50 gap-2">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-400" />
                    <span>Ищу текст песни...</span>
                  </div>
                ) : lyricsLines.length > 0 ? (
                  lyricsLines.map((line, idx) => {
                    const isActive = idx === activeLyricIndex;
                    return (
                      <p
                        key={idx}
                        ref={isActive ? activeLineRef : null}
                        className={`text-lg font-medium transition-all duration-300 ${
                          isActive
                            ? 'text-teal-300 scale-[1.02] origin-left'
                            : 'text-white/40'
                        }`}
                      >
                        {line.text}
                      </p>
                    );
                  })
                ) : plainLyrics ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-white/80 leading-relaxed">
                    {plainLyrics}
                  </pre>
                ) : (
                  <p className="text-center text-white/45 py-16 text-sm">
                    Текст для этого трека пока не найден.
                  </p>
                )}
              </div>
            )}

            {activeDrawer === 'eq' && (
              <div className="space-y-5">
                <div className="flex flex-wrap gap-2">
                  {Object.keys(EQ_PRESETS).map((preset) => (
                    <button
                      key={preset}
                      onClick={() => onApplyPreset(preset)}
                      className={`px-3.5 py-1.5 rounded-full text-xs font-medium border transition cursor-pointer ${
                        activePreset === preset
                          ? 'bg-teal-500/25 border-teal-400 text-teal-200'
                          : 'bg-white/[0.05] border-white/10 text-white/70 hover:text-white'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-10 gap-1.5 sm:gap-2 pt-2">
                  {EQ_FREQUENCIES.map((freq, idx) => (
                    <div key={freq} className="flex flex-col items-center gap-2">
                      <span className="text-[10px] font-mono text-teal-300">
                        {eqGains[idx] > 0 ? `+${eqGains[idx]}` : eqGains[idx]}
                      </span>
                      <input
                        type="range"
                        min={-12}
                        max={12}
                        step={1}
                        value={eqGains[idx]}
                        onChange={(e) => onUpdateBandGain(idx, Number(e.target.value))}
                        className="h-28 w-2 appearance-none bg-white/15 rounded-lg accent-teal-400 cursor-pointer"
                        style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                      />
                      <span className="text-[10px] text-white/50">
                        {freq >= 1000 ? `${freq / 1000}k` : freq}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeDrawer === 'sleep' && (
              <div className="space-y-4 py-2">
                <p className="text-xs text-white/60">
                  Музыка плавно затухнет и поставится на паузу по истечении выбранного времени.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {[15, 30, 60].map((mins) => (
                    <button
                      key={mins}
                      onClick={() => {
                        onStartSleep(mins);
                        onClose();
                      }}
                      className="py-3 rounded-2xl bg-white/[0.06] hover:bg-indigo-500/25 border border-white/10 hover:border-indigo-400/50 text-sm font-medium text-white transition cursor-pointer"
                    >
                      {mins} минут
                    </button>
                  ))}
                </div>

                {sleepSecondsLeft !== null && (
                  <div className="flex items-center justify-between p-3.5 rounded-2xl bg-indigo-500/15 border border-indigo-400/30">
                    <span className="text-xs text-indigo-200">
                      Осталось: {Math.floor(sleepSecondsLeft / 60)}:
                      {String(sleepSecondsLeft % 60).padStart(2, '0')}
                    </span>
                    <button
                      onClick={onCancelSleep}
                      className="text-xs text-rose-300 hover:underline cursor-pointer"
                    >
                      Отменить
                    </button>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}