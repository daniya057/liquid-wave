'use client';

import { useState, useEffect } from 'react';

export interface LyricLine {
  time: number;
  text: string;
}

function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

  for (const rawLine of lrc.split('\n')) {
    const match = rawLine.match(regex);
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, '0'), 10);
    const text = match[4].trim();
    if (text) {
      lines.push({ time: minutes * 60 + seconds + ms / 1000, text });
    }
  }
  return lines;
}

export function useLyrics(title?: string, artist?: string, currentTime = 0) {
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [plainText, setPlainText] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!title) {
      setLines([]);
      setPlainText('');
      return;
    }

    let cancelled = false;
    const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();

    async function fetchLyrics() {
      setLoading(true);
      setLines([]);
      setPlainText('');
      try {
        const artistPart = artist ? artist : '';
        const query = encodeURIComponent(`${cleanTitle} ${artistPart}`.trim());
        const res = await fetch(`https://lrclib.net/api/search?q=${query}`);
        if (!res.ok) return;
        const results = await res.json();
        if (cancelled || !Array.isArray(results) || results.length === 0) return;

        const best = results.find((r) => r.syncedLyrics) || results[0];
        if (best.syncedLyrics) {
          setLines(parseLrc(best.syncedLyrics));
        } else if (best.plainLyrics) {
          setPlainText(best.plainLyrics);
        }
      } catch {
        // Игнорируем ошибку, если текст не найден
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchLyrics();
    return () => {
      cancelled = true;
    };
  }, [title, artist]);

  const activeIndex = lines.reduce((acc, line, idx) => {
    return currentTime >= line.time ? idx : acc;
  }, -1);

  return { lines, plainText, activeIndex, loading };
}