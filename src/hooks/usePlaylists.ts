'use client';

import { useState, useEffect, useCallback } from 'react';
import { Playlist, Track } from '@/lib/instances';

const STORAGE_KEY = 'lw-user-playlists';

function saveToStorage(list: Playlist[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // игнорируем ошибку записи
  }
}

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setPlaylists(parsed);
        }
      }
    } catch {
      // игнорируем ошибку чтения
    }
  }, []);

  const createPlaylist = useCallback(
    (name: string, initialTrack?: Track): Playlist => {
      let created!: Playlist;

      setPlaylists((prev) => {
        const safePrev = Array.isArray(prev) ? prev : [];
        created = {
          id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: name.trim() || `Мой плейлист #${safePrev.length + 1}`,
          tracks: initialTrack ? [initialTrack] : [],
          createdAt: Date.now(),
        };
        const next = [created, ...safePrev];
        saveToStorage(next);
        return next;
      });

      return created;
    },
    []
  );

  const importPlaylist = useCallback((name: string, tracks: Track[]): Playlist => {
    let created!: Playlist;

    setPlaylists((prev) => {
      const safePrev = Array.isArray(prev) ? prev : [];
      created = {
        id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: name.trim() || `Импорт #${safePrev.length + 1}`,
        tracks,
        createdAt: Date.now(),
      };
      const next = [created, ...safePrev];
      saveToStorage(next);
      return next;
    });

    return created;
  }, []);

  const deletePlaylist = useCallback((playlistId: string) => {
    setPlaylists((prev) => {
      const next = prev.filter((p) => p.id !== playlistId);
      saveToStorage(next);
      return next;
    });
  }, []);

  const toggleTrackInPlaylist = useCallback((playlistId: string, track: Track) => {
    setPlaylists((prev) => {
      const next = prev.map((pl) => {
        if (pl.id !== playlistId) return pl;
        const exists = pl.tracks.some((t) => t.id === track.id);
        return {
          ...pl,
          tracks: exists
            ? pl.tracks.filter((t) => t.id !== track.id)
            : [track, ...pl.tracks],
        };
      });
      saveToStorage(next);
      return next;
    });
  }, []);

  const removeTrackFromPlaylist = useCallback((playlistId: string, trackId: string) => {
    setPlaylists((prev) => {
      const next = prev.map((pl) => {
        if (pl.id !== playlistId) return pl;
        return {
          ...pl,
          tracks: pl.tracks.filter((t) => t.id !== trackId),
        };
      });
      saveToStorage(next);
      return next;
    });
  }, []);

  return {
    playlists,
    createPlaylist,
    importPlaylist,
    deletePlaylist,
    toggleTrackInPlaylist,
    removeTrackFromPlaylist,
  };
}