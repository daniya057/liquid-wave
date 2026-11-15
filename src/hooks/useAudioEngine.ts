'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, -1, 1],
  pop: [-1, 2, 4, 2, -1],
  rock: [4, 2, -1, 3, 5],
  electronic: [5, 3, -2, 2, 5],
  vocal: [-2, -1, 4, 4, 1],
  chill: [2, 1, 0, -2, -3],
};

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function useAudioEngine(onEnded?: () => void, onError?: () => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const shouldPlayRef = useRef(false);
  const lastSrcRef = useRef('');
  const lastKnownTimeRef = useRef(0);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const lastPosUpdateRef = useRef(0);
  const lastNativePlayTimeRef = useRef(0);
  const playRequestIdRef = useRef(0);
  const retryCountRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
  const resumeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const graphConnectedRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [eqGains, setEqGains] = useState<number[]>([0, 0, 0, 0, 0]);
  const [activePreset, setActivePreset] = useState<string>('flat');

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const clearResumeWatchdog = useCallback(() => {
    if (resumeWatchdogRef.current) {
      clearTimeout(resumeWatchdogRef.current);
      resumeWatchdogRef.current = null;
    }
  }, []);

  const ensureAudioGraph = useCallback(
    (forceConnect = false) => {
      if (typeof window === 'undefined') return;
      if (isIOSDevice()) return;

      const audio = audioRef.current;
      if (!audio) return;

      const hasActiveEq = forceConnect || eqGains.some((g) => g !== 0);
      if (!hasActiveEq && !graphConnectedRef.current) {
        return;
      }

      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;

        if (!audioCtxRef.current) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;

          ctx.addEventListener('statechange', () => {
            if (
              (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') &&
              shouldPlayRef.current
            ) {
              ctx.resume().catch(() => {});
            }
          });
        }

        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
          ctx.resume().catch(() => {});
        }

        if (!graphConnectedRef.current) {
          if (!sourceNodeRef.current) {
            sourceNodeRef.current = ctx.createMediaElementSource(audio);
          }

          const filters = EQ_FREQUENCIES.map((freq, idx) => {
            const filter = ctx.createBiquadFilter();
            filter.type =
              idx === 0 ? 'lowshelf' : idx === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
            filter.frequency.value = freq;
            filter.Q.value = 1;
            filter.gain.value = eqGains[idx] || 0;
            return filter;
          });

          filtersRef.current = filters;

          let prev: AudioNode = sourceNodeRef.current;
          for (const f of filters) {
            prev.connect(f);
            prev = f;
          }
          prev.connect(ctx.destination);
          graphConnectedRef.current = true;
        }
      } catch {}
    },
    [eqGains]
  );

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    const src = audio.currentSrc || audio.src || lastSrcRef.current;
    if (!src) return;

    ensureAudioGraph(false);
    clearResumeWatchdog();

    const reqId = ++playRequestIdRef.current;
    consecutiveErrorsRef.current = 0;
    shouldPlayRef.current = true;

    const savedTime =
      audio.currentTime > 0 && isFinite(audio.currentTime)
        ? audio.currentTime
        : lastKnownTimeRef.current;

    // Если iOS сбросил буфер или разорвал сетевое соединение во время паузы — переподключаем поток
    const needsReconnect =
      Boolean(audio.error) ||
      audio.readyState === 0 ||
      audio.networkState === 3 ||
      !audio.src;

    if (needsReconnect) {
      if (savedTime > 0.5) {
        pendingSeekTimeRef.current = savedTime;
      }
      audio.src = src;
    }

    setIsLoading(true);
    try {
      await audio.play();
      if (playRequestIdRef.current === reqId) {
        setIsPlaying(true);
      }
    } catch (err: any) {
      if (playRequestIdRef.current === reqId && err?.name !== 'AbortError') {
        // Фолбэк: принудительно переподключаем src с сохранением позиции
        if (savedTime > 0.5) {
          pendingSeekTimeRef.current = savedTime;
        }
        audio.src = src;
        audio.play().catch(() => {
          if (playRequestIdRef.current === reqId) {
            setIsPlaying(false);
            setIsLoading(false);
          }
        });
      }
    }

    // Watchdog для iOS: если через 1.8с после нажатия Play звук так и не пошёл — переподключаем сокет
    resumeWatchdogRef.current = setTimeout(() => {
      const el = audioRef.current;
      if (!el || !shouldPlayRef.current || playRequestIdRef.current !== reqId) return;
      if (el.paused || el.readyState < 3) {
        const pos =
          el.currentTime > 0 && isFinite(el.currentTime)
            ? el.currentTime
            : lastKnownTimeRef.current;
        if (pos > 0.5) {
          pendingSeekTimeRef.current = pos;
        }
        el.src = src;
        el.play().catch(() => {});
      }
    }, 1800);
  }, [ensureAudioGraph, clearResumeWatchdog]);

  const pause = useCallback(() => {
    shouldPlayRef.current = false;
    clearResumeWatchdog();
    const audio = audioRef.current;
    if (audio) {
      if (audio.currentTime > 0 && isFinite(audio.currentTime)) {
        lastKnownTimeRef.current = audio.currentTime;
      }
      if (!audio.paused) {
        audio.pause();
      }
    }
    setIsPlaying(false);
    setIsLoading(false);
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'paused';
      } catch {}
    }
  }, [clearResumeWatchdog]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const syncMediaSessionPlayback = (state: 'playing' | 'paused') => {
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = state;
        } catch {}
      }
    };

    const updateMediaPosition = () => {
      if (
        typeof navigator !== 'undefined' &&
        'mediaSession' in navigator &&
        typeof navigator.mediaSession.setPositionState === 'function' &&
        audio.duration &&
        isFinite(audio.duration) &&
        audio.duration > 0
      ) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(audio.currentTime || 0, audio.duration),
          });
        } catch {}
      }
    };

    const handlePlayEvent = () => {
      lastNativePlayTimeRef.current = Date.now();
      shouldPlayRef.current = true;
      syncMediaSessionPlayback('playing');
    };

    const handlePlaying = () => {
      clearResumeWatchdog();
      retryCountRef.current = 0;
      consecutiveErrorsRef.current = 0;
      shouldPlayRef.current = true;
      setIsPlaying(true);
      setIsLoading(false);
      syncMediaSessionPlayback('playing');
      if (
        audioCtxRef.current &&
        (audioCtxRef.current.state === 'suspended' ||
          (audioCtxRef.current.state as string) === 'interrupted')
      ) {
        audioCtxRef.current.resume().catch(() => {});
      }
      updateMediaPosition();
    };

    const handlePause = () => {
      // Игнорируем промежуточную паузу при смене src во время авто-ретрая/переподключения
      if (!audio.ended && !audio.error && Date.now() - lastNativePlayTimeRef.current > 150) {
        shouldPlayRef.current = false;
      }
      if (audio.currentTime > 0 && isFinite(audio.currentTime)) {
        lastKnownTimeRef.current = audio.currentTime;
      }
      clearResumeWatchdog();
      setIsPlaying(false);
      setIsLoading(false);
      syncMediaSessionPlayback('paused');
    };

    const handleWaiting = () => {
      if (shouldPlayRef.current) {
        setIsLoading(true);
      }
    };

    const handleCanPlay = () => {
      setIsLoading(false);
      if (shouldPlayRef.current && audio.paused) {
        audio.play().catch(() => {});
      }
    };

    const handleTimeUpdate = () => {
      const now = Date.now();
      const t = audio.currentTime || 0;
      if (t > 0 && isFinite(t)) {
        lastKnownTimeRef.current = t;
      }
      setCurrentTime(t);
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
      if (now - lastPosUpdateRef.current > 2000) {
        lastPosUpdateRef.current = now;
        updateMediaPosition();
      }
    };

    const handleLoadedMetadata = () => {
      setIsLoading(false);
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
        if (pendingSeekTimeRef.current !== null && pendingSeekTimeRef.current > 0) {
          const target = Math.min(pendingSeekTimeRef.current, Math.max(0, audio.duration - 0.5));
          pendingSeekTimeRef.current = null;
          try {
            audio.currentTime = target;
            setCurrentTime(target);
          } catch {}
        }
        updateMediaPosition();
      }
    };

    const handleEnded = () => {
      clearResumeWatchdog();
      lastKnownTimeRef.current = 0;
      pendingSeekTimeRef.current = null;
      setIsPlaying(false);
      setIsLoading(false);
      if (onEndedRef.current) {
        onEndedRef.current();
      } else {
        shouldPlayRef.current = false;
      }
    };

    const handleError = () => {
      if (!audio.error) return;
      clearResumeWatchdog();

      if (shouldPlayRef.current && retryCountRef.current < 1 && lastSrcRef.current) {
        retryCountRef.current += 1;
        if (lastKnownTimeRef.current > 0.5) {
          pendingSeekTimeRef.current = lastKnownTimeRef.current;
        }
        setTimeout(() => {
          if (!shouldPlayRef.current || !audioRef.current) return;
          audioRef.current.src = lastSrcRef.current;
          audioRef.current.play().catch(() => {});
        }, 200);
        return;
      }

      if (shouldPlayRef.current && consecutiveErrorsRef.current < 5) {
        consecutiveErrorsRef.current += 1;
        setIsLoading(false);
        const skipToNext = onErrorRef.current || onEndedRef.current;
        if (skipToNext) {
          skipToNext();
          return;
        }
      }

      shouldPlayRef.current = false;
      setIsLoading(false);
      setIsPlaying(false);
    };

    audio.addEventListener('play', handlePlayEvent);
    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    // Регистрируем системные кнопки Play/Pause для iOS Control Center / экрана блокировки
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          resume();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          pause();
        });
      } catch {}
    }

    return () => {
      clearResumeWatchdog();
      audio.removeEventListener('play', handlePlayEvent);
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, [resume, pause, clearResumeWatchdog]);

  const playStream = useCallback(
    async (src: string) => {
      const audio = audioRef.current;
      if (!audio || typeof src !== 'string' || !src) return;

      ensureAudioGraph(false);
      clearResumeWatchdog();

      const reqId = ++playRequestIdRef.current;
      retryCountRef.current = 0;
      lastKnownTimeRef.current = 0;
      pendingSeekTimeRef.current = null;
      lastSrcRef.current = src;
      shouldPlayRef.current = true;
      setIsLoading(true);
      setCurrentTime(0);
      setDuration(0);

      audio.src = src;

      try {
        await audio.play();
        if (playRequestIdRef.current === reqId) {
          setIsPlaying(true);
        }
      } catch (err: any) {
        if (playRequestIdRef.current === reqId && err?.name !== 'AbortError') {
          setIsPlaying(false);
        }
      } finally {
        if (playRequestIdRef.current === reqId) {
          setIsLoading(false);
        }
      }
    },
    [ensureAudioGraph, clearResumeWatchdog]
  );

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    // Защита от двойного срабатывания на iOS, когда Safari сам снял трек с паузы прямо перед вызовом togglePlay()
    if (!audio.paused && Date.now() - lastNativePlayTimeRef.current < 500) {
      shouldPlayRef.current = true;
      setIsPlaying(true);
      return;
    }

    if (audio.paused || audio.ended || audio.error) {
      await resume();
    } else {
      pause();
    }
  }, [resume, pause]);

  const seek = useCallback((timeSec: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(timeSec)) return;
    const clamped = Math.max(0, Math.min(timeSec, audio.duration || timeSec));
    lastKnownTimeRef.current = clamped;
    audio.currentTime = clamped;
    setCurrentTime(clamped);
  }, []);

  const setVolume = useCallback((val: number) => {
    const clamped = Math.max(0, Math.min(1, val));
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  const updateBandGain = useCallback(
    (bandIndex: number, gain: number) => {
      ensureAudioGraph(true);
      setEqGains((prev) => {
        const next = [...prev];
        next[bandIndex] = gain;
        return next;
      });
      if (filtersRef.current[bandIndex]) {
        filtersRef.current[bandIndex].gain.value = gain;
      }
      setActivePreset('custom');
    },
    [ensureAudioGraph]
  );

  const applyPreset = useCallback(
    (presetName: string) => {
      const gains = EQ_PRESETS[presetName] || EQ_PRESETS.flat;
      if (gains.some((g) => g !== 0)) {
        ensureAudioGraph(true);
      }
      setEqGains(gains);
      setActivePreset(presetName);
      gains.forEach((g, idx) => {
        if (filtersRef.current[idx]) {
          filtersRef.current[idx].gain.value = g;
        }
      });
    },
    [ensureAudioGraph]
  );

  return {
    audioRef,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    volume,
    eqGains,
    activePreset,
    playStream,
    resume,
    togglePlay,
    pause,
    seek,
    setVolume,
    updateBandGain,
    applyPreset,
  };
}