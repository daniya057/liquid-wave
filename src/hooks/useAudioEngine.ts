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

export function useAudioEngine(onEnded?: () => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef(onEnded);

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

  const ensureAudioGraph = useCallback(
    (forceConnect = false) => {
      if (typeof window === 'undefined') return;
      const audio = audioRef.current;
      if (!audio) return;

      if (isIOSDevice() && !forceConnect && !graphConnectedRef.current) {
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
              audioRef.current &&
              !audioRef.current.paused
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
      } catch {
        // Если Web Audio недоступен, <audio> продолжает играть напрямую
      }
    },
    [eqGains]
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => {
      setIsPlaying(true);
      setIsLoading(false);
      if (
        audioCtxRef.current &&
        (audioCtxRef.current.state === 'suspended' ||
          (audioCtxRef.current.state as string) === 'interrupted')
      ) {
        audioCtxRef.current.resume().catch(() => {});
      }
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleWaiting = () => {
      setIsLoading(true);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime || 0);
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handleLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      if (onEndedRef.current) {
        onEndedRef.current();
      }
    };

    const handleError = () => {
      setIsLoading(false);
      setIsPlaying(false);
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('playing', handleCanPlay);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('playing', handleCanPlay);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  const playStream = useCallback(
    async (src: string) => {
      const audio = audioRef.current;
      if (!audio || typeof src !== 'string' || !src) return;

      ensureAudioGraph(false);

      setIsLoading(true);
      setCurrentTime(0);
      setDuration(0);

      audio.src = src;
      audio.load();

      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      } finally {
        setIsLoading(false);
      }
    },
    [ensureAudioGraph]
  );

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;

    ensureAudioGraph(false);

    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        // игнорируем
      }
    } else {
      audio.pause();
    }
  }, [ensureAudioGraph]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (audio && !audio.paused) {
      audio.pause();
    }
  }, []);

  const seek = useCallback((timeSec: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(timeSec)) return;
    const clamped = Math.max(0, Math.min(timeSec, audio.duration || timeSec));
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
      const hasNonZero = gains.some((g) => g !== 0);
      if (hasNonZero) {
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
    togglePlay,
    pause,
    seek,
    setVolume,
    updateBandGain,
    applyPreset,
  };
}