'use client';

import { useState, useEffect, useCallback } from 'react';
import { get, set, del, keys } from 'idb-keyval';
import { Track } from '@/lib/instances';

interface StoredTrack {
  track: Track;
  blob: Blob;
}

export function useOfflineAudio() {
  const [savedTracks, setSavedTracks] = useState<Track[]>([]);
  const [downloadingIds, setDownloadingIds] = useState<Record<string, boolean>>({});

  const refreshSavedTracks = useCallback(async () => {
    try {
      const allKeys = await keys();
      const trackKeys = allKeys.filter((k) => typeof k === 'string' && k.startsWith('lw-track-'));
      const list: Track[] = [];
      for (const key of trackKeys) {
        const item = await get<StoredTrack>(key);
        if (item?.track) list.push(item.track);
      }
      setSavedTracks(list);
    } catch (e) {
      console.error('Ошибка чтения офлайн-кэша:', e);
    }
  }, []);

  useEffect(() => {
    refreshSavedTracks();
  }, [refreshSavedTracks]);

  const downloadTrack = useCallback(async (track: Track) => {
    setDownloadingIds((prev) => ({ ...prev, [track.id]: true }));
    try {
      const res = await fetch(`/api/stream/${track.id}`);
      if (!res.ok) throw new Error('Не удалось скачать аудио');
      const blob = await res.blob();
      await set(`lw-track-${track.id}`, { track, blob });
      await refreshSavedTracks();
    } catch (e) {
      console.error('Ошибка скачивания трека:', e);
    } finally {
      setDownloadingIds((prev) => ({ ...prev, [track.id]: false }));
    }
  }, [refreshSavedTracks]);

  const removeSavedTrack = useCallback(async (trackId: string) => {
    await del(`lw-track-${trackId}`);
    await refreshSavedTracks();
  }, [refreshSavedTracks]);

  const getOfflineUrl = useCallback(async (trackId: string): Promise<string | null> => {
    const item = await get<StoredTrack>(`lw-track-${trackId}`);
    if (!item?.blob) return null;
    return URL.createObjectURL(item.blob);
  }, []);

  const isSaved = useCallback(
    (trackId: string) => savedTracks.some((t) => t.id === trackId),
    [savedTracks]
  );

  return {
    savedTracks,
    downloadingIds,
    downloadTrack,
    removeSavedTrack,
    getOfflineUrl,
    isSaved,
  };
}
