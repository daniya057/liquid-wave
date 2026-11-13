'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [7, 6, 4, 2, 0, 0, 0, 1, 2, 2],
  Vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  Electronic: [5, 4, 1, 0, -2, 1, 2, 4, 5, 6],
};

export function useAudioEngine(onTrackEnded?: () => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const sourceConnectedRef = useRef(false);
  const onTrackEndedRef = useRef(onTrackEnded);
  const consecutiveErrorsRef = useRef(0);

  useEffect(() => {
    onTrackEndedRef.current = onTrackEnded;
  }, [onTrackEnded]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [eqGains, setEqGains] = useState<number[]>(EQ_PRESETS.Flat);
  const [activePreset, setActivePreset] = useState<string>('Flat');

  const ensureAudioContext = useCallback(async () => {
    if (!audioRef.current) return;

    if (!audioCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      if (!sourceConnectedRef.current) {
        const source = ctx.createMediaElementSource(audioRef.current);
        const filters = EQ_FREQUENCIES.map((freq, index) => {
          const filter = ctx.createBiquadFilter();
          filter.type =
            index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
          filter.frequency.value = freq;
          filter.Q.value = 1.4;
          filter.gain.value = eqGains[index] || 0;
          return filter;
        });

        filters
          .reduce((prev, curr) => {
            prev.connect(curr);
            return curr;
          }, source as AudioNode)
          .connect(ctx.destination);

        filtersRef.current = filters;
        sourceConnectedRef.current = true;
      }
    }

    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }
  }, [eqGains]);

  const playStream = useCallback(
    async (src: string) => {
      if (!audioRef.current) return;
      setIsLoading(true);
      try {
        await ensureAudioContext();
        audioRef.current.src = src;
        audioRef.current.load();
        await audioRef.current.play();
        consecutiveErrorsRef.current = 0;
        setIsPlaying(true);
      } catch (err) {
        console.error('Ошибка запуска аудио:', err);
        setIsPlaying(false);
      } finally {
        setIsLoading(false);
      }
    },
    [ensureAudioContext]
  );

  const togglePlay = useCallback(async () => {
    if (!audioRef.current || !audioRef.current.src) return;
    try {
      await ensureAudioContext();
      if (audioRef.current.paused) {
        await audioRef.current.play();
        setIsPlaying(true);
      } else {
        audioRef.current.pause();
        setIsPlaying(false);
      }
    } catch (err) {
      console.error('Ошибка паузы/воспроизведения:', err);
      setIsPlaying(false);
    }
  }, [ensureAudioContext]);

  const pause = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setIsPlaying(false);
  }, []);

  const seek = useCallback((time: number) => {
    if (!audioRef.current || !isFinite(time)) return;
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((val: number) => {
    const clamped = Math.max(0, Math.min(1, val));
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  const updateBandGain = useCallback((index: number, gain: number) => {
    setEqGains((prev) => {
      const next = [...prev];
      next[index] = gain;
      return next;
    });
    setActivePreset('Custom');
    if (filtersRef.current[index]) {
      filtersRef.current[index].gain.value = gain;
    }
  }, []);

  const applyPreset = useCallback((presetName: string) => {
    const gains = EQ_PRESETS[presetName];
    if (!gains) return;
    setEqGains(gains);
    setActivePreset(presetName);
    gains.forEach((g, idx) => {
      if (filtersRef.current[idx]) {
        filtersRef.current[idx].gain.value = g;
      }
    });
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const handleLoadedMetadata = () => setDuration(audio.duration || 0);
    const handleWaiting = () => setIsLoading(true);
    const handleCanPlay = () => {
      setIsLoading(false);
      consecutiveErrorsRef.current = 0;
    };

    const handleEnded = () => {
      setIsPlaying(false);
      consecutiveErrorsRef.current = 0;
      onTrackEndedRef.current?.();
    };

    // Если поток оборвался на последней секунде или трек недоступен — автоматически переходим к следующему
    const handleError = () => {
      setIsLoading(false);
      setIsPlaying(false);
      if (!audio.src || audio.src === window.location.href) return;

      consecutiveErrorsRef.current += 1;
      if (consecutiveErrorsRef.current <= 3) {
        onTrackEndedRef.current?.();
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, []);

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
    togglePlay,
    pause,
    seek,
    setVolume,
    updateBandGain,
    applyPreset,
  };
}