'use client';

import { useState } from 'react';
import { Track } from '@/lib/instances';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Heart,
  Download,
  Check,
  Loader2,
  Mic2,
  SlidersHorizontal,
  Moon,
  Volume2,
  VolumeX,
  ListPlus,
  ChevronDown,
  Disc3,
} from 'lucide-react';

interface PlayerBarProps {
  track: Track | null;
  isPlaying: boolean;
  isLoading: boolean;
  isShuffled: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isLiked: boolean;
  isSaved: boolean;
  isDownloading: boolean;
  sleepSecondsLeft: number | null;
  onTogglePlay: () => void;
  onToggleShuffle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
  onVolumeChange: (val: number) => void;
  onToggleLike: () => void;
  onDownload: () => void;
  onAddToPlaylist: () => void;
  onOpenDrawer: (drawer: 'lyrics' | 'eq' | 'sleep') => void;
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function PlayerBar({
  track,
  isPlaying,
  isLoading,
  isShuffled,
  currentTime,
  duration,
  volume,
  isLiked,
  isSaved,
  isDownloading,
  sleepSecondsLeft,
  onTogglePlay,
  onToggleShuffle,
  onPrev,
  onNext,
  onSeek,
  onVolumeChange,
  onToggleLike,
  onDownload,
  onAddToPlaylist,
  onOpenDrawer,
}: PlayerBarProps) {
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const safeDuration = duration ? duration : track?.duration ? track.duration : 0;
  const progress = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;

  return (
    <>
      {/* ==================== ДЕСКТОПНАЯ НИЖНЯЯ ПАНЕЛЬ (ПК) ==================== */}
      <div className="hidden md:grid grid-cols-3 items-center fixed bottom-0 inset-x-0 h-24 bg-[#0c0c10]/95 backdrop-blur-2xl border-t border-white/10 px-6 z-30">
        {/* Левая часть: Обложка, название, лайк, добавить в плейлист */}
        <div className="flex items-center gap-3.5 min-w-0 pr-4">
          <div className="w-14 h-14 rounded-xl overflow-hidden bg-white/[0.06] border border-white/10 shrink-0 flex items-center justify-center">
            {track?.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={track.thumbnail} alt="" className="w-full h-full object-cover" />
            ) : (
              <Disc3 className="w-6 h-6 text-white/30" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white truncate">
              {track ? track.title : 'Ничего не играет'}
            </p>
            <p className="text-xs text-white/50 truncate mt-0.5">
              {track ? track.artist : 'Выбери трек, альбом или плейлист'}
            </p>
          </div>

          {track && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onToggleLike}
                title="В избранное"
                className="p-2 rounded-xl hover:bg-white/10 text-white/65 hover:text-pink-400 transition cursor-pointer"
              >
                <Heart className={`w-4 h-4 ${isLiked ? 'fill-pink-400 text-pink-400' : ''}`} />
              </button>
              <button
                onClick={onAddToPlaylist}
                title="Добавить в плейлист"
                className="p-2 rounded-xl hover:bg-white/10 text-white/65 hover:text-teal-300 transition cursor-pointer"
              >
                <ListPlus className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Центральная часть: Перемешивание, управление и полоса перемотки */}
        <div className="flex flex-col items-center gap-2 max-w-xl w-full mx-auto">
          <div className="flex items-center gap-4">
            <button
              onClick={onToggleShuffle}
              title={isShuffled ? 'Перемешивание включено' : 'Перемешать'}
              className={`p-2 rounded-xl transition cursor-pointer ${
                isShuffled
                  ? 'text-teal-300 bg-teal-500/15'
                  : 'text-white/50 hover:text-white hover:bg-white/10'
              }`}
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={onPrev}
              disabled={!track}
              title="Предыдущий трек"
              className="p-2 text-white/70 hover:text-white disabled:opacity-30 transition cursor-pointer"
            >
              <SkipBack className="w-5 h-5" />
            </button>

            <button
              onClick={onTogglePlay}
              disabled={!track}
              className="w-10 h-10 rounded-full bg-white text-zinc-950 flex items-center justify-center hover:scale-105 active:scale-95 disabled:opacity-35 transition cursor-pointer shadow"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isPlaying ? (
                <Pause className="w-5 h-5 fill-zinc-950" />
              ) : (
                <Play className="w-5 h-5 fill-zinc-950 ml-0.5" />
              )}
            </button>

            <button
              onClick={onNext}
              disabled={!track}
              title="Следующий трек"
              className="p-2 text-white/70 hover:text-white disabled:opacity-30 transition cursor-pointer"
            >
              <SkipForward className="w-5 h-5" />
            </button>
          </div>

          <div className="w-full flex items-center gap-2.5">
            <span className="text-[11px] font-mono text-white/45 w-9 text-right">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={safeDuration ? safeDuration : 100}
              value={currentTime}
              disabled={!track}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="flex-1 h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-teal-400"
              style={{
                background: `linear-gradient(to right, #2dd4bf ${progress}%, rgba(255,255,255,0.15) ${progress}%)`,
              }}
            />
            <span className="text-[11px] font-mono text-white/45 w-9">
              {formatTime(safeDuration)}
            </span>
          </div>
        </div>

        {/* Правая часть: Текст, Эквалайзер, Таймер сна, Скачать, Громкость */}
        <div className="flex items-center justify-end gap-2 pl-4">
          {track && (
            <button
              onClick={onDownload}
              disabled={isDownloading || isSaved}
              title={isSaved ? 'Сохранено в офлайн' : 'Скачать в офлайн'}
              className={`p-2 rounded-xl hover:bg-white/10 transition cursor-pointer ${
                isSaved ? 'text-teal-300' : 'text-white/65 hover:text-white'
              }`}
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin text-teal-300" />
              ) : isSaved ? (
                <Check className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>
          )}

          <button
            onClick={() => onOpenDrawer('lyrics')}
            title="Текст песни"
            className="p-2 rounded-xl hover:bg-white/10 text-white/65 hover:text-violet-300 transition cursor-pointer"
          >
            <Mic2 className="w-4 h-4" />
          </button>

          <button
            onClick={() => onOpenDrawer('eq')}
            title="Эквалайзер"
            className="p-2 rounded-xl hover:bg-white/10 text-white/65 hover:text-teal-300 transition cursor-pointer"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          <button
            onClick={() => onOpenDrawer('sleep')}
            title="Таймер сна"
            className={`p-2 rounded-xl hover:bg-white/10 transition cursor-pointer ${
              sleepSecondsLeft !== null ? 'text-indigo-300' : 'text-white/65 hover:text-white'
            }`}
          >
            <Moon className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2 ml-2 pl-2 border-l border-white/10">
            <button
              onClick={() => onVolumeChange(volume > 0 ? 0 : 1)}
              className="text-white/65 hover:text-white transition cursor-pointer"
            >
              {volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="w-20 h-1 bg-white/15 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>
        </div>
      </div>

      {/* ==================== МОБИЛЬНЫЙ МИНИ-ПЛЕЕР (ТЕЛЕФОН) ==================== */}
      {track && !mobileExpanded && (
        <div
          onClick={() => setMobileExpanded(true)}
          className="md:hidden fixed bottom-16 inset-x-2 z-30 rounded-2xl bg-[#14141a]/95 backdrop-blur-2xl border border-white/15 p-2.5 shadow-2xl overflow-hidden cursor-pointer"
        >
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-white/10">
            <div className="h-full bg-teal-400 transition-all" style={{ width: `${progress}%` }} />
          </div>

          <div className="flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-10 h-10 rounded-xl overflow-hidden bg-white/10 shrink-0">
                {track.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={track.thumbnail} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Disc3 className="w-5 h-5 m-2.5 text-white/40" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate">{track.title}</p>
                <p className="text-[11px] text-white/55 truncate">{track.artist}</p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={onToggleLike}
                className="p-2 text-white/70 hover:text-pink-400"
              >
                <Heart className={`w-4 h-4 ${isLiked ? 'fill-pink-400 text-pink-400' : ''}`} />
              </button>
              <button
                onClick={onTogglePlay}
                className="w-9 h-9 rounded-full bg-white text-zinc-950 flex items-center justify-center"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isPlaying ? (
                  <Pause className="w-4 h-4 fill-zinc-950" />
                ) : (
                  <Play className="w-4 h-4 fill-zinc-950 ml-0.5" />
                )}
              </button>
              <button onClick={onNext} className="p-2 text-white/75">
                <SkipForward className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== ПОЛНОЭКРАННЫЙ ПЛЕЕР ДЛЯ ТЕЛЕФОНА ==================== */}
      {track && mobileExpanded && (
        <div className="md:hidden fixed inset-0 z-40 bg-[#09090b] flex flex-col justify-between p-6 overflow-y-auto">
          {track.thumbnail && (
            <div
              className="absolute inset-0 opacity-25 blur-3xl pointer-events-none"
              style={{
                backgroundImage: `url(${track.thumbnail})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          )}

          <div className="relative z-10 flex items-center justify-between">
            <button
              onClick={() => setMobileExpanded(false)}
              className="p-2 rounded-full bg-white/10 text-white"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
            <span className="text-xs uppercase tracking-widest text-white/60">Сейчас играет</span>
            <button
              onClick={onAddToPlaylist}
              className="p-2 rounded-full bg-white/10 text-white"
            >
              <ListPlus className="w-5 h-5" />
            </button>
          </div>

          <div className="relative z-10 my-6 flex flex-col items-center">
            <div className="w-64 h-64 rounded-3xl overflow-hidden bg-white/10 border border-white/15 shadow-2xl">
              {track.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={track.thumbnail} alt="" className="w-full h-full object-cover" />
              ) : (
                <Disc3 className="w-16 h-16 m-24 text-white/30" />
              )}
            </div>

            <div className="w-full flex items-center justify-between mt-6 gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-white truncate">{track.title}</h2>
                <p className="text-sm text-white/60 truncate">{track.artist}</p>
              </div>
              <button
                onClick={onToggleLike}
                className="p-2.5 rounded-full bg-white/10 text-white shrink-0"
              >
                <Heart className={`w-5 h-5 ${isLiked ? 'fill-pink-400 text-pink-400' : ''}`} />
              </button>
            </div>
          </div>

          <div className="relative z-10 space-y-6">
            <div className="space-y-1.5">
              <input
                type="range"
                min={0}
                max={safeDuration ? safeDuration : 100}
                value={currentTime}
                onChange={(e) => onSeek(Number(e.target.value))}
                className="w-full h-1.5 bg-white/15 rounded-lg appearance-none accent-teal-400"
                style={{
                  background: `linear-gradient(to right, #2dd4bf ${progress}%, rgba(255,255,255,0.15) ${progress}%)`,
                }}
              />
              <div className="flex justify-between text-xs font-mono text-white/50">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(safeDuration)}</span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-6">
              <button
                onClick={onToggleShuffle}
                className={`p-3 rounded-full ${
                  isShuffled ? 'text-teal-300 bg-teal-500/20' : 'text-white/55'
                }`}
              >
                <Shuffle className="w-5 h-5" />
              </button>
              <button onClick={onPrev} className="p-3 text-white/80">
                <SkipBack className="w-7 h-7" />
              </button>
              <button
                onClick={onTogglePlay}
                className="w-16 h-16 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-xl"
              >
                {isLoading ? (
                  <Loader2 className="w-7 h-7 animate-spin" />
                ) : isPlaying ? (
                  <Pause className="w-7 h-7 fill-zinc-950" />
                ) : (
                  <Play className="w-7 h-7 fill-zinc-950 ml-0.5" />
                )}
              </button>
              <button onClick={onNext} className="p-3 text-white/80">
                <SkipForward className="w-7 h-7" />
              </button>
            </div>

            <div className="grid grid-cols-4 gap-2 pt-2">
              <button
                onClick={() => onOpenDrawer('lyrics')}
                className="flex flex-col items-center gap-1 py-2.5 rounded-2xl bg-white/[0.07] text-[11px] text-white/80"
              >
                <Mic2 className="w-4 h-4 text-violet-300" />
                <span>Текст</span>
              </button>
              <button
                onClick={() => onOpenDrawer('eq')}
                className="flex flex-col items-center gap-1 py-2.5 rounded-2xl bg-white/[0.07] text-[11px] text-white/80"
              >
                <SlidersHorizontal className="w-4 h-4 text-teal-300" />
                <span>EQ</span>
              </button>
              <button
                onClick={() => onOpenDrawer('sleep')}
                className="flex flex-col items-center gap-1 py-2.5 rounded-2xl bg-white/[0.07] text-[11px] text-white/80"
              >
                <Moon className="w-4 h-4 text-indigo-300" />
                <span>Таймер</span>
              </button>
              <button
                onClick={onDownload}
                disabled={isDownloading || isSaved}
                className="flex flex-col items-center gap-1 py-2.5 rounded-2xl bg-white/[0.07] text-[11px] text-white/80"
              >
                {isSaved ? (
                  <Check className="w-4 h-4 text-teal-300" />
                ) : (
                  <Download className="w-4 h-4 text-teal-300" />
                )}
                <span>{isSaved ? 'Офлайн' : 'Скачать'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}