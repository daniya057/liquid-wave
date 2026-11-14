// @ts-nocheck
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration?: number;
}

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, { name: string; gains: number[] }> = {
  flat: { name: 'Обычный', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Бас', gains: [6, 5, 4, 2, 0, 0, 0, 0, 1, 2] },
  rock: { name: 'Рок', gains: [5, 4, 2, 0, -1, -1, 1, 3, 4, 5] },
  pop: { name: 'Поп', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  electronic: { name: 'Электроника', gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  vocal: { name: 'Вокал', gains: [-2, -2, -1, 1, 4, 5, 4, 2, 0, -1] },
};

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export function useAudioEngine(onEndedOrOptions?: any) {
  const audioRef = useRef<any>(null);
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef<Track | null>(null);
  const errStreakRef = useRef(0);

  const onEndedRef = useRef<any>(null);
  onEndedRef.current =
    typeof onEndedOrOptions === 'function'
      ? onEndedOrOptions
      : typeof onEndedOrOptions?.onEnded === 'function'
        ? onEndedOrOptions.onEnded
        : null;

  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(100);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eqGains, setEqGains] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [activePreset, setActivePreset] = useState('flat');

  const currentTrack = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;
  const stateRef = useRef({ queue, currentIndex });
  stateRef.current = { queue, currentIndex };

  const loadAndPlay = useCallback((track: Track) => {
    setError(null);
    setIsLoading(true);
    setCurrentTime(0);
    if (track.duration) setDuration(track.duration);

    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator && track.title) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'Liquid Wave',
        album: 'Liquid Wave',
        artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : [],
      });
    }

    if (readyRef.current && playerRef.current?.loadVideoById) {
      playerRef.current.loadVideoById({ videoId: track.id, startSeconds: 0 });
    } else {
      pendingRef.current = track;
    }
  }, []);

  const playNext = useCallback(() => {
    if (onEndedRef.current) {
      onEndedRef.current();
      return;
    }
    const { queue: q, currentIndex: idx } = stateRef.current;
    if (idx + 1 < q.length) {
      setCurrentIndex(idx + 1);
      loadAndPlay(q[idx + 1]);
    } else {
      setIsPlaying(false);
    }
  }, [loadAndPlay]);

  const playPrev = useCallback(() => {
    const { queue: q, currentIndex: idx } = stateRef.current;
    if (playerRef.current?.getCurrentTime?.() > 3) {
      playerRef.current.seekTo(0, true);
      setCurrentTime(0);
      return;
    }
    if (q.length > 0) {
      const prevIdx = Math.max(0, idx - 1);
      setCurrentIndex(prevIdx);
      loadAndPlay(q[prevIdx]);
    }
  }, [loadAndPlay]);

  useEffect(() => {
    const init = () => {
      if (playerRef.current || !document.getElementById('yt-global-player')) return;
      playerRef.current = new window.YT.Player('yt-global-player', {
        height: '1',
        width: '1',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: (e: any) => {
            readyRef.current = true;
            e.target.setVolume(100);
            if (pendingRef.current) {
              const t = pendingRef.current;
              pendingRef.current = null;
              e.target.loadVideoById(t.id);
            }
          },
          onStateChange: (e: any) => {
            if (e.data === 1) {
              errStreakRef.current = 0;
              setIsPlaying(true);
              setIsLoading(false);
              const d = e.target.getDuration?.();
              if (d > 0) setDuration(d);
            } else if (e.data === 2) {
              setIsPlaying(false);
              setIsLoading(false);
            } else if (e.data === 3) {
              setIsLoading(true);
            } else if (e.data === 0) {
              setIsPlaying(false);
              playNext();
            }
          },
          onError: () => {
            setIsLoading(false);
            errStreakRef.current += 1;
            if (errStreakRef.current < 3) {
              setTimeout(playNext, 500);
            } else {
              setError('Трек недоступен');
              errStreakRef.current = 0;
            }
          },
        },
      });
    };

    if (window.YT?.Player) {
      init();
    } else {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        init();
      };
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.async = true;
        document.body.appendChild(s);
      }
    }

    const timer = setInterval(() => {
      if (readyRef.current && playerRef.current?.getPlayerState?.() === 1) {
        setCurrentTime(playerRef.current.getCurrentTime?.() || 0);
        const d = playerRef.current.getDuration?.() || 0;
        if (d > 0) setDuration(d);
      }
    }, 250);

    return () => clearInterval(timer);
  }, [playNext]);

  const playStream = useCallback((input: string | Track, ..._rest: any[]) => {
    if (!input) return;
    const track: Track =
      typeof input === 'string'
        ? {
            id: input.includes('/api/stream/') ? input.split('/api/stream/')[1].split('?')[0] : input,
            title: '',
            artist: '',
            thumbnail: '',
          }
        : input;
    errStreakRef.current = 0;
    loadAndPlay(track);
  }, [loadAndPlay]);

  const playTrack = useCallback((track: Track, newQueue?: Track[]) => {
    errStreakRef.current = 0;
    if (newQueue?.length) {
      setQueue(newQueue);
      const idx = newQueue.findIndex((t) => t.id === track.id);
      setCurrentIndex(idx >= 0 ? idx : 0);
    }
    loadAndPlay(track);
  }, [loadAndPlay]);

  const togglePlay = useCallback((..._args: any[]) => {
    if (!readyRef.current || !playerRef.current) return;
    isPlaying ? playerRef.current.pauseVideo() : playerRef.current.playVideo();
  }, [isPlaying]);

  const seekTo = useCallback((sec: number) => {
    if (!readyRef.current || !playerRef.current) return;
    playerRef.current.seekTo(sec, true);
    setCurrentTime(sec);
  }, []);

  const setVolume = useCallback((val: number) => {
    const v = Math.max(0, Math.min(100, val));
    setVolumeState(v);
    if (readyRef.current && playerRef.current) {
      playerRef.current.setVolume(v);
      if (v > 0 && isMuted) {
        playerRef.current.unMute();
        setIsMuted(false);
      }
    }
  }, [isMuted]);

  const toggleMute = useCallback((..._args: any[]) => {
    if (!readyRef.current || !playerRef.current) return;
    if (isMuted) {
      playerRef.current.unMute();
      setIsMuted(false);
    } else {
      playerRef.current.mute();
      setIsMuted(true);
    }
  }, [isMuted]);

  const setBandGain = useCallback((idx: number, gain: number) => {
    setActivePreset('custom');
    setEqGains((prev) => prev.map((g, i) => (i === idx ? gain : g)));
  }, []);

  const applyPreset = useCallback((key: string) => {
    if (!EQ_PRESETS[key]) return;
    setActivePreset(key);
    setEqGains([...EQ_PRESETS[key].gains]);
  }, []);

  return {
    audioRef, currentTrack, queue, setQueue, isPlaying, isLoading, isBuffering: isLoading,
    currentTime, progress: currentTime, duration, volume, isMuted, error,
    eqGains, activePreset, setBandGain, updateBandGain: setBandGain, setEqGain: setBandGain,
    applyPreset, applyEqPreset: applyPreset, resetEq: (..._args: any[]) => applyPreset('flat'),
    playStream, playTrack,
    play: (...args: any[]) => (args[0] ? playStream(args[0]) : playerRef.current?.playVideo?.()),
    pause: (..._args: any[]) => playerRef.current?.pauseVideo?.(),
    togglePlay, toggle: togglePlay,
    playNext: (..._args: any[]) => playNext(), nextTrack: (..._args: any[]) => playNext(),
    playPrev: (..._args: any[]) => playPrev(), prevTrack: (..._args: any[]) => playPrev(),
    seekTo, seek: seekTo, setVolume, toggleMute,
  };
}