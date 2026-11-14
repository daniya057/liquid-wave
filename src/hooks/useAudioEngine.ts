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

const resolvedYtqCache = new Map<string, string>();

function configureIosAudioSession() {
  if (typeof navigator !== 'undefined' && 'audioSession' in navigator) {
    try {
      (navigator as any).audioSession.type = 'playback';
    } catch {
      // игнорируем
    }
  }
}

export function useAudioEngine(onEndedOrOptions?: any) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const ytReadyRef = useRef(false);
  const pendingYtIdRef = useRef<string | null>(null);
  const modeRef = useRef<'native' | 'youtube'>('native');
  const lastUrlRef = useRef<string>('');
  const fallbackTimerRef = useRef<any>(null);

  // Отслеживаем прогресс, чтобы перехватывать конец трека через loop=true без закрытия аудиосессии iOS
  const maxReachedTimeRef = useRef<number>(0);
  const userSeekingRef = useRef<boolean>(false);
  const trackTransitionLockRef = useRef<boolean>(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const eqConnectedRef = useRef(false);

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

  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  const ensureEqGraph = useCallback(() => {
    const el = audioRef.current;
    if (!el || eqConnectedRef.current || typeof window === 'undefined') return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(el);
      const filters = EQ_FREQUENCIES.map((freq, i) => {
        const filter = ctx.createBiquadFilter();
        filter.type = i === 0 ? 'lowshelf' : i === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.4;
        filter.gain.value = 0;
        return filter;
      });

      source.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i++) {
        filters[i].connect(filters[i + 1]);
      }
      filters[filters.length - 1].connect(ctx.destination);

      audioCtxRef.current = ctx;
      filtersRef.current = filters;
      eqConnectedRef.current = true;
    } catch {
      // Игнорируем
    }
  }, []);

  const stopYoutube = useCallback(() => {
    try {
      ytPlayerRef.current?.stopVideo?.();
    } catch {
      // игнорируем
    }
  }, []);

  const startYoutubeFallback = useCallback(async (rawUrl: string) => {
    clearFallbackTimer();
    modeRef.current = 'youtube';

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
    }

    let cleanId = rawUrl.replace('/api/stream/', '').split('?')[0];
    try {
      cleanId = decodeURIComponent(cleanId);
    } catch {}

    if (cleanId.startsWith('ytq:')) {
      const cached = resolvedYtqCache.get(cleanId);
      if (cached) {
        cleanId = cached;
      } else {
        try {
          const encodedQuery = cleanId.split(':').slice(2).join(':');
          const res = await fetch(`/api/search?q=${encodedQuery}`);
          const data = await res.json();
          const bestId = data?.tracks?.[0]?.id;
          if (!bestId) {
            setIsLoading(false);
            setIsPlaying(false);
            setError('Трек не найден');
            return;
          }
          resolvedYtqCache.set(cleanId, bestId);
          cleanId = bestId;
        } catch {
          setIsLoading(false);
          setIsPlaying(false);
          setError('Ошибка поиска трека');
          return;
        }
      }
    }

    if (ytReadyRef.current && ytPlayerRef.current?.loadVideoById) {
      ytPlayerRef.current.loadVideoById({ videoId: cleanId, startSeconds: 0 });
      setTimeout(() => {
        ytPlayerRef.current?.playVideo?.();
      }, 200);
    } else {
      pendingYtIdRef.current = cleanId;
    }
  }, []);

  const playStream = useCallback(
    async (input: string | Track) => {
      if (!input) return;
      configureIosAudioSession();

      const url =
        typeof input === 'string'
          ? input
          : input.id.startsWith('blob:') || input.id.startsWith('/') || input.id.startsWith('http')
            ? input.id
            : `/api/stream/${encodeURIComponent(input.id)}`;

      lastUrlRef.current = url;
      maxReachedTimeRef.current = 0;
      trackTransitionLockRef.current = false;
      clearFallbackTimer();
      setError(null);
      setIsLoading(true);
      setCurrentTime(0);
      stopYoutube();
      modeRef.current = 'native';

      const el = audioRef.current;
      if (!el) return;

      // Держим loop = true, чтобы iOS не закрывал системную аудиосессию на заблокированном экране
      el.loop = true;

      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      // Даём серверу до 12 секунд на прогрев потока (yt-dlp / SoundCloud), прежде чем откатываться на YouTube IFrame
      if (!url.startsWith('blob:')) {
        fallbackTimerRef.current = setTimeout(() => {
          if (modeRef.current === 'native' && el.paused) {
            startYoutubeFallback(url);
          }
        }, 12000);
      }

      el.src = url;
      el.load();

      try {
        await el.play();
        clearFallbackTimer();
        setIsPlaying(true);
        setIsLoading(false);
      } catch {
        clearFallbackTimer();
        if (!url.startsWith('blob:')) {
          startYoutubeFallback(url);
        } else {
          setIsLoading(false);
          setIsPlaying(false);
        }
      }
    },
    [stopYoutube, startYoutubeFallback]
  );

  const playNext = useCallback(() => {
    if (onEndedRef.current) {
      onEndedRef.current();
      return;
    }
    const { queue: q, currentIndex: idx } = stateRef.current;
    if (idx + 1 < q.length) {
      const next = q[idx + 1];
      setCurrentIndex(idx + 1);
      playStream(next);
    } else {
      setIsPlaying(false);
    }
  }, [playStream]);

  const playPrev = useCallback(() => {
    const el = audioRef.current;
    if (modeRef.current === 'native' && el && el.currentTime > 3) {
      userSeekingRef.current = true;
      el.currentTime = 0;
      maxReachedTimeRef.current = 0;
      setCurrentTime(0);
      setTimeout(() => {
        userSeekingRef.current = false;
      }, 300);
      return;
    }
    const { queue: q, currentIndex: idx } = stateRef.current;
    if (q.length > 0) {
      const prevIdx = Math.max(0, idx - 1);
      setCurrentIndex(prevIdx);
      playStream(q[prevIdx]);
    }
  }, [playStream]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const triggerNextInBackground = () => {
      if (trackTransitionLockRef.current) return;
      trackTransitionLockRef.current = true;
      maxReachedTimeRef.current = 0;
      // Ставим на паузу (это сохраняет аудиосессию iOS открытой) и сразу запускаем следующий трек
      el.pause();
      playNext();
    };

    const onPlay = () => {
      if (modeRef.current !== 'native') return;
      configureIosAudioSession();
      clearFallbackTimer();
      setIsPlaying(true);
      setIsLoading(false);
    };

    const onPlaying = () => {
      if (modeRef.current !== 'native') return;
      configureIosAudioSession();
      setIsPlaying(true);
      setIsLoading(false);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
        try {
          navigator.mediaSession.setActionHandler('seekbackward', null);
          navigator.mediaSession.setActionHandler('seekforward', null);
          navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
          navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
        } catch {
          // игнорируем
        }
      }
    };

    const onPause = () => {
      if (modeRef.current !== 'native') return;
      setIsPlaying(false);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    };

    const onWaiting = () => {
      if (modeRef.current !== 'native') return;
      setIsLoading(true);
    };

    const onCanPlay = () => {
      if (modeRef.current !== 'native') return;
      clearFallbackTimer();
      setIsLoading(false);
      if (isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
      }
    };

    const onSeeking = () => {
      if (modeRef.current !== 'native') return;
      // Если трек доиграл до конца и из-за loop=true перепрыгнул в 0:00
      if (
        !userSeekingRef.current &&
        maxReachedTimeRef.current > 10 &&
        isFinite(el.duration) &&
        el.duration > 15 &&
        el.currentTime < 1.5 &&
        el.duration - maxReachedTimeRef.current < 3
      ) {
        triggerNextInBackground();
      }
    };

    const onTimeUpdate = () => {
      if (modeRef.current !== 'native') return;
      clearFallbackTimer();
      setIsLoading(false);

      const cur = el.currentTime || 0;
      const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;

      // Запасной перехват петли в 0:00 для iOS Safari
      if (
        !userSeekingRef.current &&
        maxReachedTimeRef.current > 10 &&
        dur > 15 &&
        cur < 1.5 &&
        dur - maxReachedTimeRef.current < 3
      ) {
        triggerNextInBackground();
        return;
      }

      if (cur > maxReachedTimeRef.current) {
        maxReachedTimeRef.current = cur;
      }

      setCurrentTime(cur);
      if (dur > 0) {
        setDuration(dur);
      }
    };

    const onEnded = () => {
      if (modeRef.current !== 'native') return;
      triggerNextInBackground();
    };

    const onError = () => {
      if (modeRef.current !== 'native') return;
      clearFallbackTimer();
      const src = el.getAttribute('src') || '';
      if (src && !src.startsWith('blob:')) {
        startYoutubeFallback(src);
      } else {
        setIsLoading(false);
        setIsPlaying(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden && audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('pause', onPause);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('seeking', onSeeking);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('seeking', onSeeking);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [playNext, playPrev, startYoutubeFallback]);

  useEffect(() => {
    const init = () => {
      if (ytPlayerRef.current || !document.getElementById('yt-global-player')) return;
      ytPlayerRef.current = new window.YT.Player('yt-global-player', {
        height: '180',
        width: '320',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0 },
        events: {
          onReady: (e: any) => {
            ytReadyRef.current = true;
            e.target.setVolume(volume);
            if (pendingYtIdRef.current) {
              const id = pendingYtIdRef.current;
              pendingYtIdRef.current = null;
              e.target.loadVideoById(id);
            }
          },
          onStateChange: (e: any) => {
            if (modeRef.current !== 'youtube') return;
            if (e.data === 1) {
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
              setIsLoading(false);
              playNext();
            }
          },
          onError: () => {
            if (modeRef.current !== 'youtube') return;
            setIsLoading(false);
            setIsPlaying(false);
            setError('Трек недоступен');
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
      if (modeRef.current === 'youtube' && ytReadyRef.current && ytPlayerRef.current?.getPlayerState?.() === 1) {
        setIsLoading(false);
        setCurrentTime(ytPlayerRef.current.getCurrentTime?.() || 0);
        const d = ytPlayerRef.current.getDuration?.() || 0;
        if (d > 0) setDuration(d);
      }
    }, 250);

    return () => {
      clearInterval(timer);
      clearFallbackTimer();
    };
  }, [playNext, volume]);

  const playTrack = useCallback(
    (track: Track, newQueue?: Track[]) => {
      if (newQueue?.length) {
        setQueue(newQueue);
        const idx = newQueue.findIndex((t) => t.id === track.id);
        setCurrentIndex(idx >= 0 ? idx : 0);
      }
      playStream(track);
    },
    [playStream]
  );

  const togglePlay = useCallback(() => {
    setIsLoading(false);
    configureIosAudioSession();

    if (modeRef.current === 'native') {
      const el = audioRef.current;
      if (!el) return;

      if (el.error || !el.getAttribute('src')) {
        if (lastUrlRef.current) {
          playStream(lastUrlRef.current);
        }
        return;
      }

      if (el.paused) {
        if (audioCtxRef.current?.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
        el.play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            if (lastUrlRef.current && !lastUrlRef.current.startsWith('blob:')) {
              startYoutubeFallback(lastUrlRef.current);
            }
          });
      } else {
        el.pause();
        setIsPlaying(false);
      }
      return;
    }

    if (!ytReadyRef.current || !ytPlayerRef.current) return;
    const state = ytPlayerRef.current.getPlayerState?.();
    if (state === 1) {
      ytPlayerRef.current.pauseVideo();
      setIsPlaying(false);
    } else {
      ytPlayerRef.current.playVideo();
      setIsPlaying(true);
    }
  }, [playStream, startYoutubeFallback]);

  const pause = useCallback(() => {
    setIsLoading(false);
    setIsPlaying(false);
    if (modeRef.current === 'native') {
      audioRef.current?.pause();
    } else {
      ytPlayerRef.current?.pauseVideo?.();
    }
  }, []);

  const seekTo = useCallback((sec: number) => {
    if (modeRef.current === 'native') {
      const el = audioRef.current;
      if (!el) return;
      userSeekingRef.current = true;
      maxReachedTimeRef.current = sec;
      el.currentTime = sec;
      setCurrentTime(sec);
      setTimeout(() => {
        userSeekingRef.current = false;
      }, 300);
      return;
    }
    if (!ytReadyRef.current || !ytPlayerRef.current) return;
    ytPlayerRef.current.seekTo(sec, true);
    setCurrentTime(sec);
  }, []);

  const setVolume = useCallback(
    (val: number) => {
      const v = Math.max(0, Math.min(100, val));
      setVolumeState(v);
      if (audioRef.current) {
        audioRef.current.volume = v / 100;
        if (v > 0 && audioRef.current.muted) {
          audioRef.current.muted = false;
          setIsMuted(false);
        }
      }
      if (ytReadyRef.current && ytPlayerRef.current) {
        ytPlayerRef.current.setVolume(v);
        if (v > 0 && isMuted) {
          ytPlayerRef.current.unMute();
          setIsMuted(false);
        }
      }
    },
    [isMuted]
  );

  const toggleMute = useCallback(() => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    if (audioRef.current) audioRef.current.muted = nextMute;
    if (ytReadyRef.current && ytPlayerRef.current) {
      if (nextMute) ytPlayerRef.current.mute();
      else ytPlayerRef.current.unMute();
    }
  }, [isMuted]);

  const setBandGain = useCallback(
    (idx: number, gain: number) => {
      ensureEqGraph();
      setActivePreset('custom');
      setEqGains((prev) => {
        const next = prev.map((g, i) => (i === idx ? gain : g));
        filtersRef.current.forEach((f, i) => {
          if (f) f.gain.value = next[i] || 0;
        });
        return next;
      });
    },
    [ensureEqGraph]
  );

  const applyPreset = useCallback(
    (key: string) => {
      if (!EQ_PRESETS[key]) return;
      if (key !== 'flat') ensureEqGraph();
      const gains = [...EQ_PRESETS[key].gains];
      setActivePreset(key);
      setEqGains(gains);
      filtersRef.current.forEach((f, i) => {
        if (f) f.gain.value = gains[i] || 0;
      });
    },
    [ensureEqGraph]
  );

  return {
    audioRef,
    currentTrack,
    queue,
    setQueue,
    isPlaying,
    isLoading,
    isBuffering: isLoading,
    currentTime,
    progress: currentTime,
    duration,
    volume,
    isMuted,
    error,
    eqGains,
    activePreset,
    setBandGain,
    updateBandGain: setBandGain,
    setEqGain: setBandGain,
    applyPreset,
    applyEqPreset: applyPreset,
    resetEq: () => applyPreset('flat'),
    playStream,
    playTrack,
    play: (arg?: any) => {
      if (arg) return playStream(arg);
      togglePlay();
    },
    pause,
    togglePlay,
    toggle: togglePlay,
    playNext,
    nextTrack: playNext,
    playPrev,
    prevTrack: playPrev,
    seekTo,
    seek: seekTo,
    setVolume,
    toggleMute,
  };
}