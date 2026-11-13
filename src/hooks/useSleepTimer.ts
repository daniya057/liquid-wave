'use client';

import { useState, useEffect, useCallback } from 'react';

export function useSleepTimer(
  onSleep: () => void,
  currentVolume: number,
  setVolume: (v: number) => void
) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const startTimer = useCallback((minutes: number) => {
    setSecondsLeft(minutes * 60);
  }, []);

  const cancelTimer = useCallback(() => {
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (secondsLeft === null) return;

    if (secondsLeft <= 0) {
      onSleep();
      setVolume(1);
      setSecondsLeft(null);
      return;
    }

    // Плавное затухание громкости в последние 10 секунд
    if (secondsLeft <= 10 && currentVolume > 0.1) {
      setVolume(Math.max(0.05, currentVolume - 0.1));
    }

    const id = setTimeout(() => {
      setSecondsLeft((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);

    return () => clearTimeout(id);
  }, [secondsLeft, onSleep, currentVolume, setVolume]);

  return { secondsLeft, startTimer, cancelTimer };
}