'use client';

import { Track } from '@/lib/instances';
import {
  Play,
  Pause,
  SkipForward,
  Heart,
  Download,
  Check,
  Loader2,
  Mic2,
  SlidersHorizontal,
  Moon,
  Disc3,
} from 'lucide-react';

interface PlayerProps {
  track: Track | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  isLiked: boolean;
  isSaved: boolean;
  isDownloading: boolean;
  sleepSecondsLeft: number | null;
  onTogglePlay: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  onToggleLike: () => void;
  onDownload: () => void;
  onOpenDrawer: (drawer: 'lyrics' | 'eq' | 'sleep') => void;
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function Player({
  track,
  isPlaying,
  isLoading,
  currentTime,
  duration,
  isLiked,
  isSaved,
  isDownloading,
  sleepSecondsLeft,
  onTogglePlay,
  onNext,
  onSeek,
  onToggleLike,
  onDownload,
  onOpenDrawer,
}: PlayerProps) {
  const safeDuration = duration ? duration : track?.duration ? track.duration : 0;
  const progress = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;

  return (
    <div className="relative rounded-3xl bg-white/[0.04] backdrop-blur-2xl border border-white/10 p-5 sm:p-6 overflow-hidden shadow-2xl">
      {track?.thumbnail && (
        <div
          className="absolute -inset-10 opacity-30 blur-3xl pointer-events-none transition-all duration-1000 scale-125"
          style={{
            backgroundImage: `url(${track.thumbnail})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}

      <div className="relative z-10 flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <div className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-2xl overflow-hidden bg-white/[0.06] border border-white/15 shrink-0 flex items-center justify-center shadow-lg">
            {track?.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={track.thumbnail}
                alt={track.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <Disc3 className="w-9 h-9 text-white/30" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-base sm:text-lg font-semibold text-white truncate">
              {track ? track.title : 'Волна ещё не играет'}
            </p>
            <p className="text-xs sm:text-sm text-white/60 truncate mt-0.5">
              {track ? track.artist : 'Нажми на сферу или выбери трек'}
            </p>

            {track && (
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={onToggleLike}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition cursor-pointer ${
                    isLiked
                      ? 'bg-pink-500/20 border-pink-400/40 text-pink-300'
                      : 'bg-white/[0.05] border-white/10 text-white/70 hover:text-white'
                  }`}
                >
                  <Heart className={`w-3.5 h-3.5 ${isLiked ? 'fill-pink-400 text-pink-400' : ''}`} />
                  <span>{isLiked ? 'В избранном' : 'Нравится'}</span>
                </button>

                <button
                  onClick={onDownload}
                  disabled={isDownloading || isSaved}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition cursor-pointer ${
                    isSaved
                      ? 'bg-teal-500/20 border-teal-400/40 text-teal-300'
                      : 'bg-white/[0.05] border-white/10 text-white/70 hover:text-white'
                  }`}
                >
                  {isDownloading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-300" />
                  ) : isSaved ? (
                    <Check className="w-3.5 h-3.5 text-teal-300" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>{isDownloading ? 'Качаю...' : isSaved ? 'Офлайн' : 'Скачать'}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <input
            type="range"
            min={0}
            max={safeDuration ? safeDuration : 100}
            value={currentTime}
            disabled={!track}
            onChange={(e) => onSeek(Number(e.target.value))}
            className="w-full h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-teal-400"
            style={{
              background: `linear-gradient(to right, #2dd4bf ${progress}%, rgba(255,255,255,0.15) ${progress}%)`,
            }}
          />
          <div className="flex justify-between text-[11px] text-white/50 font-mono">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(safeDuration)}</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-5">
          <button
            onClick={onTogglePlay}
            disabled={!track}
            className="w-14 h-14 rounded-full bg-white text-zinc-950 flex items-center justify-center hover:scale-105 active:scale-95 transition disabled:opacity-40 cursor-pointer shadow-lg"
          >
            {isLoading ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : isPlaying ? (
              <Pause className="w-6 h-6 fill-zinc-950" />
            ) : (
              <Play className="w-6 h-6 fill-zinc-950 ml-0.5" />
            )}
          </button>

          <button
            onClick={onNext}
            disabled={!track}
            title="Следующий трек"
            className="w-11 h-11 rounded-full bg-white/[0.07] border border-white/10 text-white flex items-center justify-center hover:bg-white/15 transition disabled:opacity-40 cursor-pointer"
          >
            <SkipForward className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-1">
          <button
            onClick={() => onOpenDrawer('lyrics')}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-2xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs text-white/85 transition cursor-pointer"
          >
            <Mic2 className="w-3.5 h-3.5 text-violet-300 shrink-0" />
            <span className="truncate">Текст песни</span>
          </button>

          <button
            onClick={() => onOpenDrawer('eq')}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-2xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs text-white/85 transition cursor-pointer"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-teal-300 shrink-0" />
            <span className="truncate">Эквалайзер</span>
          </button>

          <button
            onClick={() => onOpenDrawer('sleep')}
            className={`flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-2xl border text-xs transition cursor-pointer ${
              sleepSecondsLeft !== null
                ? 'bg-indigo-500/25 border-indigo-400/50 text-indigo-200'
                : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/10 text-white/85'
            }`}
          >
            <Moon className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
            <span className="truncate">
              {sleepSecondsLeft !== null
                ? `${Math.ceil(sleepSecondsLeft / 60)} мин`
                : 'Таймер сна'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}