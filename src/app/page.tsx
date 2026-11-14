'use client';
import { MoodFilterBar } from '@/components/MoodFilterBar';
import { MoodType, filterTracksByMood } from '@/lib/trackMood';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Track, Album, Artist, Playlist } from '@/lib/instances';
import { useAudioEngine } from '@/hooks/useAudioEngine';
import { useLyrics } from '@/hooks/useLyrics';
import { useSleepTimer } from '@/hooks/useSleepTimer';
import { useOfflineAudio } from '@/hooks/useOfflineAudio';
import { usePlaylists } from '@/hooks/usePlaylists';
import { PlayerBar } from '@/components/PlayerBar';
import { PlaylistModal } from '@/components/PlaylistModal';
import { BottomDrawers } from '@/components/BottomDrawers';
import {
  Search,
  Radio,
  Heart,
  Download,
  Play,
  Shuffle,
  Trash2,
  Loader2,
  ListMusic,
  Plus,
  Check,
  Disc,
  User,
  ArrowLeft,
  ListPlus,
  Link2,
  Clock,
  TrendingUp,
  X,
} from 'lucide-react';

const INITIAL_SUGGESTIONS = [
  'Miyagi & Эндшпиль',
  'Скриптонит',
  'Три дня дождя',
  'MACAN',
  'The Weeknd',
  'Billie Eilish',
  'Phonk',
  'Инди-рок',
  'Synthwave',
  'Lo-Fi для учёбы',
];

function formatDuration(sec: number): string {
  if (!sec || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function shuffleTracks(list: Track[], keepFirstId?: string): Track[] {
  const copy = [...list];
  let pinned: Track | undefined;

  if (keepFirstId) {
    const idx = copy.findIndex((t) => t.id === keepFirstId);
    if (idx >= 0) {
      [pinned] = copy.splice(idx, 1);
    }
  }

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return pinned ? [pinned, ...copy] : copy;
}

export default function HomePage() {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [originalQueue, setOriginalQueue] = useState<Track[]>([]);
  const [isShuffled, setIsShuffled] = useState(false);

  const [section, setSection] = useState<'explore' | 'playlists' | 'liked' | 'offline'>('explore');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [selectedMood, setSelectedMood] = useState<MoodType>('all');

  // Глобальный поиск и подсказки
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTab, setSearchTab] = useState<'all' | 'tracks' | 'albums' | 'artists'>('all');
  const [foundTracks, setFoundTracks] = useState<Track[]>([]);
  const [foundAlbums, setFoundAlbums] = useState<Album[]>([]);
  const [foundArtists, setFoundArtists] = useState<Artist[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>(INITIAL_SUGGESTIONS);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  // Просмотр альбома или артиста
  const [artistTab, setArtistTab] = useState<'all' | 'tracks' | 'albums'>('all');
  const [collectionView, setCollectionView] = useState<{
    type: 'album' | 'artist';
    title: string;
    subtitle?: string;
    thumbnail?: string;
    tracks: Track[];
    albums?: (Album & { year?: string; type?: string })[];
    loading: boolean;
  } | null>(null);

  // Создание и импорт плейлистов
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Поиск и добавление треков прямо внутри открытого плейлиста
  const [inPlaylistQuery, setInPlaylistQuery] = useState('');
  const [inPlaylistResults, setInPlaylistResults] = useState<Track[]>([]);
  const [isInPlaylistSearching, setIsInPlaylistSearching] = useState(false);

  const [likedTracks, setLikedTracks] = useState<Track[]>([]);
  const [playlistModalTrack, setPlaylistModalTrack] = useState<Track | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<'lyrics' | 'eq' | 'sleep' | null>(null);

  const prefetchedIdsRef = useRef<Set<string>>(new Set());

  const {
    playlists,
    createPlaylist,
    importPlaylist,
    deletePlaylist,
    toggleTrackInPlaylist,
    removeTrackFromPlaylist,
  } = usePlaylists();

  const {
    savedTracks,
    downloadingIds,
    downloadTrack,
    removeSavedTrack,
    getOfflineUrl,
    isSaved,
  } = useOfflineAudio();

  useEffect(() => {
    try {
      const raw = localStorage.getItem('lw-liked-tracks');
      if (raw) setLikedTracks(JSON.parse(raw));
      const rawHistory = localStorage.getItem('lw-recent-searches');
      if (rawHistory) setRecentSearches(JSON.parse(rawHistory));
    } catch {
      // игнорируем
    }

    fetch('/api/search?mode=suggestions')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.suggestions) && d.suggestions.length > 0) {
          setSuggestions(d.suggestions);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    const q = searchQuery.trim();
    const timer = setTimeout(() => {
      const url = q
        ? `/api/search?mode=suggestions&q=${encodeURIComponent(q)}`
        : '/api/search?mode=suggestions';
      fetch(url)
        .then((r) => r.json())
        .then((d) => {
          if (Array.isArray(d?.suggestions) && d.suggestions.length > 0) {
            setSuggestions(d.suggestions);
          }
        })
        .catch(() => {});
    }, 180);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const saveRecentSearch = (term: string) => {
    const clean = term.trim();
    if (!clean) return;
    setRecentSearches((prev) => {
      const next = [clean, ...prev.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(
        0,
        6
      );
      try {
        localStorage.setItem('lw-recent-searches', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const removeRecentSearch = (term: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecentSearches((prev) => {
      const next = prev.filter((item) => item !== term);
      try {
        localStorage.setItem('lw-recent-searches', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const prefetchTrack = useCallback(
    (track?: Track) => {
      if (!track || isSaved(track.id) || prefetchedIdsRef.current.has(track.id)) return;
      prefetchedIdsRef.current.add(track.id);
      fetch(`/api/stream/${track.id}?prefetch=1`).catch(() => {
        prefetchedIdsRef.current.delete(track.id);
      });
    },
    [isSaved]
  );

  const playTrackRef = useRef<
    (track: Track, list?: Track[], forceShuffle?: boolean) => Promise<void>
  >(async () => {});

  const handleNextTrack = useCallback(async () => {
    if (!currentTrack || queue.length === 0) return;
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const nextTrack = queue[idx + 1] || queue[0];
    if (nextTrack) {
      await playTrackRef.current(nextTrack);
    }
  }, [currentTrack, queue]);

  const handlePrevTrack = useCallback(async () => {
    if (!currentTrack || queue.length === 0) return;
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const prevTrack = idx > 0 ? queue[idx - 1] : queue[queue.length - 1];
    if (prevTrack) {
      await playTrackRef.current(prevTrack);
    }
  }, [currentTrack, queue]);

  const {
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
  } = useAudioEngine(handleNextTrack);

  const playTrack = useCallback(
    async (track: Track, newQueue?: Track[], forceShuffle?: boolean) => {
      setCurrentTrack(track);
      let activeList = queue;

      if (newQueue) {
        setOriginalQueue(newQueue);
        const shouldShuffle = forceShuffle !== undefined ? forceShuffle : isShuffled;
        if (forceShuffle !== undefined) setIsShuffled(forceShuffle);
        activeList = shouldShuffle ? shuffleTracks(newQueue, track.id) : newQueue;
        setQueue(activeList);
      }

      const idx = activeList.findIndex((t) => t.id === track.id);
      if (idx >= 0 && activeList[idx + 1]) {
        prefetchTrack(activeList[idx + 1]);
      }

      if (isSaved(track.id)) {
        const offlineUrl = await getOfflineUrl(track.id);
        if (offlineUrl) {
          await playStream(offlineUrl);
          return;
        }
      }
      await playStream(`/api/stream/${track.id}`);
    },
    [queue, isShuffled, prefetchTrack, isSaved, getOfflineUrl, playStream]
  );

  useEffect(() => {
    playTrackRef.current = playTrack;
  }, [playTrack]);

  // Поддержка экрана блокировки iPhone и наушников (Media Session API)
  useEffect(() => {
    if (!currentTrack || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: 'Liquid Wave',
      artwork: currentTrack.thumbnail
        ? [{ src: currentTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => handleNextTrack());
  }, [currentTrack, isPlaying, togglePlay, pause, handlePrevTrack, handleNextTrack]);

  // Переключение режима перемешивания (Shuffle)
  const toggleShuffle = useCallback(() => {
    setIsShuffled((prev) => {
      const next = !prev;
      if (next) {
        const base = originalQueue.length > 0 ? originalQueue : queue;
        const shuffled = shuffleTracks(base, currentTrack?.id);
        setQueue(shuffled);
        if (shuffled[1]) prefetchTrack(shuffled[1]);
      } else if (originalQueue.length > 0) {
        setQueue(originalQueue);
        const idx = originalQueue.findIndex((t) => t.id === currentTrack?.id);
        if (idx >= 0 && originalQueue[idx + 1]) {
          prefetchTrack(originalQueue[idx + 1]);
        }
      }
      return next;
    });
  }, [originalQueue, queue, currentTrack, prefetchTrack]);

  // Запуск любого списка сразу вперемешку
  const playShuffledList = (list: Track[]) => {
    if (list.length === 0) return;
    const shuffled = shuffleTracks(list);
    setOriginalQueue(list);
    setIsShuffled(true);
    setQueue(shuffled);
    playTrack(shuffled[0]);
  };

  const {
    lines: lyricsLines,
    plainText: plainLyrics,
    activeIndex: activeLyricIndex,
    loading: lyricsLoading,
  } = useLyrics(currentTrack?.title, currentTrack?.artist, currentTime);

  const {
    secondsLeft: sleepSecondsLeft,
    startTimer: startSleep,
    cancelTimer: cancelSleep,
  } = useSleepTimer(pause, volume, setVolume);

  const executeSearch = async (rawQuery: string) => {
    const clean = rawQuery.trim();
    if (!clean) return;
    setSearchQuery(clean);
    setIsSearchFocused(false);
    saveRecentSearch(clean);
    setSection('explore');
    setCollectionView(null);
    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(clean)}`);
      const data = await res.json();
      setFoundTracks(data.tracks || []);
      setFoundAlbums(data.albums || []);
      setFoundArtists(data.artists || []);
      if (data.tracks?.[0]) prefetchTrack(data.tracks[0]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSearch(searchQuery);
  };

  // Поиск треков прямо внутри открытого плейлиста
  const handleInPlaylistSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inPlaylistQuery.trim()) return;
    setIsInPlaylistSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(inPlaylistQuery.trim())}`);
      const data = await res.json();
      setInPlaylistResults((data.tracks || []).slice(0, 12));
    } finally {
      setIsInPlaylistSearching(false);
    }
  };

  const openAlbum = async (album: Album) => {
    setSection('explore');
    setIsSearchFocused(false);
    setCollectionView({
      type: 'album',
      title: album.title,
      subtitle: album.artist,
      thumbnail: album.thumbnail,
      tracks: [],
      loading: true,
    });
    try {
      const res = await fetch(`/api/search?listId=${encodeURIComponent(album.id)}`);
      const data = await res.json();
      setCollectionView((prev) =>
        prev
          ? {
              ...prev,
              title: data.title || prev.title,
              subtitle: data.artist || prev.subtitle,
              thumbnail: data.thumbnail || prev.thumbnail,
              tracks: data.tracks || [],
              loading: false,
            }
          : null
      );
      if (data.tracks?.[0]) prefetchTrack(data.tracks[0]);
    } catch {
      setCollectionView((prev) => (prev ? { ...prev, loading: false } : null));
    }
  };

  const openArtist = async (artist: Artist & { browseId?: string; subscribers?: string }) => {
    setSection('explore');
    setIsSearchFocused(false);
    setArtistTab('all');
    setCollectionView({
      type: 'artist',
      title: artist.name,
      subtitle: artist.subscribers || 'Исполнитель',
      thumbnail: artist.thumbnail,
      tracks: [],
      albums: [],
      loading: true,
    });
    try {
      const queryParam = artist.browseId || artist.id?.startsWith('UC') ? artist.id : artist.name;
      const res = await fetch(`/api/search?artist=${encodeURIComponent(queryParam)}`);
      const data = await res.json();
      setCollectionView((prev) =>
        prev
          ? {
              ...prev,
              title: data.artist?.name || prev.title,
              thumbnail: data.artist?.thumbnail || prev.thumbnail,
              tracks: data.tracks || [],
              albums: data.albums || [],
              loading: false,
            }
          : null
      );
      if (data.tracks?.[0]) prefetchTrack(data.tracks[0]);
    } catch {
      setCollectionView((prev) => (prev ? { ...prev, loading: false } : null));
    }
  };

  const toggleLike = (track: Track) => {
    setLikedTracks((prev) => {
      const exists = prev.some((t) => t.id === track.id);
      const next = exists ? prev.filter((t) => t.id !== track.id) : [track, ...prev];
      localStorage.setItem('lw-liked-tracks', JSON.stringify(next));
      return next;
    });
  };

  const handleCreatePlaylistForm = (e?: React.FormEvent) => {
    e?.preventDefault();
    const title = newPlaylistName.trim() || `Мой плейлист #${playlists.length + 1}`;
    const created = createPlaylist(title);
    setNewPlaylistName('');
    setInPlaylistQuery('');
    setInPlaylistResults([]);
    setSelectedMood('all');
    if (created?.id) {
      setSelectedPlaylistId(created.id);
    }
  };

  // Импорт плейлиста из Spotify / YouTube Music / YouTube / SoundCloud
  const handleImportPlaylist = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!importUrl.trim() || isImporting) return;
    setIsImporting(true);
    setImportError(null);
    try {
      const res = await fetch('/api/import-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: importUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.tracks) || data.tracks.length === 0) {
        setImportError(data.error || 'Не удалось импортировать плейлист');
        return;
      }
      const created = importPlaylist(data.name || 'Импортированный плейлист', data.tracks);
      setImportUrl('');
      setSelectedMood('all');
      if (created?.id) {
        setSelectedPlaylistId(created.id);
      }
    } catch {
      setImportError('Ошибка сети при импорте плейлиста');
    } finally {
      setIsImporting(false);
    }
  };

  const activePlaylist: Playlist | undefined = playlists.find((p) => p.id === selectedPlaylistId);

  const visiblePlaylistTracks = useMemo(
    () => filterTracksByMood(activePlaylist?.tracks || [], selectedMood),
    [activePlaylist?.tracks, selectedMood]
  );

  const handleMoodChange = (mood: MoodType) => {
    setSelectedMood(mood);
    if (!activePlaylist) return;
    const filtered = filterTracksByMood(activePlaylist.tracks, mood);
    if (filtered.length > 0) {
      playTrack(filtered[0], filtered);
    }
  };

  const renderTrackRow = (
    track: Track,
    list: Track[],
    index: number,
    removeFromPlaylistId?: string
  ) => {
    const active = currentTrack?.id === track.id;
    const liked = likedTracks.some((t) => t.id === track.id);

    return (
      <div
        key={`${track.id}-${index}`}
        onClick={() => playTrack(track, list)}
        className={`group flex items-center justify-between gap-3 p-2.5 sm:p-3 rounded-2xl border transition cursor-pointer ${
          active
            ? 'bg-teal-500/15 border-teal-400/40'
            : 'bg-white/[0.025] hover:bg-white/[0.07] border-white/[0.07]'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="relative w-11 h-11 rounded-xl overflow-hidden bg-white/10 shrink-0 flex items-center justify-center">
            {track.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={track.thumbnail} alt="" className="w-full h-full object-cover" />
            ) : (
              <Play className="w-4 h-4 text-white/50" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className={`text-sm font-medium truncate ${active ? 'text-teal-300' : 'text-white'}`}>
              {track.title}
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openArtist({ id: track.artist, name: track.artist, thumbnail: track.thumbnail });
              }}
              className="text-xs text-white/50 hover:text-teal-300 truncate block text-left transition cursor-pointer"
            >
              {track.artist}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {track.duration > 0 && (
            <span className="hidden sm:inline text-xs font-mono text-white/40 mr-2">
              {formatDuration(track.duration)}
            </span>
          )}

          <button
            onClick={() => setPlaylistModalTrack(track)}
            title="Добавить в плейлист"
            className="p-2 rounded-xl hover:bg-white/10 text-white/55 hover:text-teal-300 transition cursor-pointer"
          >
            <ListPlus className="w-4 h-4" />
          </button>

          <button
            onClick={() => toggleLike(track)}
            title="Нравится"
            className="p-2 rounded-xl hover:bg-white/10 text-white/55 hover:text-pink-400 transition cursor-pointer"
          >
            <Heart className={`w-4 h-4 ${liked ? 'fill-pink-400 text-pink-400' : ''}`} />
          </button>

          {removeFromPlaylistId ? (
            <button
              onClick={() => removeTrackFromPlaylist(removeFromPlaylistId, track.id)}
              title="Убрать из плейлиста"
              className="p-2 rounded-xl hover:bg-white/10 text-white/55 hover:text-rose-400 transition cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          ) : section === 'offline' ? (
            <button
              onClick={() => removeSavedTrack(track.id)}
              title="Удалить из офлайна"
              className="p-2 rounded-xl hover:bg-white/10 text-white/55 hover:text-rose-400 transition cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => downloadTrack(track)}
              disabled={isSaved(track.id) || Boolean(downloadingIds[track.id])}
              title="Скачать в офлайн"
              className="p-2 rounded-xl hover:bg-white/10 text-white/55 hover:text-teal-300 disabled:opacity-40 transition cursor-pointer"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-white flex flex-col md:flex-row selection:bg-teal-500/30">
      <audio ref={audioRef} preload="auto" playsInline />

      {/* БОКОВАЯ ПАНЕЛЬ ДЛЯ КОМПЬЮТЕРА (ПК) */}
      <aside className="hidden md:flex flex-col w-64 shrink-0 bg-[#0c0c10] border-r border-white/10 p-5 pb-28 sticky top-0 h-screen">
        <div className="flex items-center gap-2.5 mb-7 px-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-teal-400 flex items-center justify-center shadow-lg">
            <Radio className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-sm font-bold tracking-wider uppercase block">Liquid Wave</span>
            <span className="text-[10px] text-white/45">Space Obsidian</span>
          </div>
        </div>

        <nav className="space-y-1">
          {[
            { id: 'explore', label: 'Поиск и обзор', icon: Search },
            { id: 'playlists', label: 'Мои плейлисты', icon: ListMusic },
            { id: 'liked', label: `Избранное (${likedTracks.length})`, icon: Heart },
            { id: 'offline', label: `Офлайн (${savedTracks.length})`, icon: Download },
          ].map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSection(item.id as typeof section);
                  setSelectedPlaylistId(null);
                  setCollectionView(null);
                  setSelectedMood('all');
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition cursor-pointer ${
                  active
                    ? 'bg-white/12 text-white'
                    : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
                }`}
              >
                <Icon className="w-4 h-4 text-teal-300" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-7 pt-5 border-t border-white/10 flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-2 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/45">
              Плейлисты
            </span>
            <button
              onClick={() => {
                setSection('playlists');
                setSelectedPlaylistId(null);
                setSelectedMood('all');
              }}
              title="Создать или импортировать"
              className="p-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-y-auto space-y-1 pr-1">
            {playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => {
                  setSection('playlists');
                  setSelectedPlaylistId(pl.id);
                  setInPlaylistQuery('');
                  setInPlaylistResults([]);
                  setSelectedMood('all');
                }}
                className={`w-full text-left px-3 py-2 rounded-xl text-xs truncate transition cursor-pointer ${
                  section === 'playlists' && selectedPlaylistId === pl.id
                    ? 'bg-teal-500/20 text-teal-200 font-medium'
                    : 'text-white/60 hover:text-white hover:bg-white/[0.05]'
                }`}
              >
                {pl.name}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ОСНОВНАЯ ОБЛАСТЬ КОНТЕНТА */}
      <main className="flex-1 min-w-0 pb-36 md:pb-32">
        <div className="sticky top-0 z-20 bg-[#09090b]/85 backdrop-blur-xl border-b border-white/[0.07] px-4 sm:px-8 py-4">
          <div className="max-w-5xl mx-auto flex items-center gap-3">
            <div className="md:hidden w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-teal-400 flex items-center justify-center shrink-0">
              <Radio className="w-4 h-4 text-white" />
            </div>

            <div ref={searchBoxRef} className="relative flex-1">
              <form onSubmit={handleSearch} className="relative">
                <Search className="w-4 h-4 text-white/40 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onFocus={() => setIsSearchFocused(true)}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setIsSearchFocused(true);
                  }}
                  placeholder="Треки, альбомы, артисты..."
                  className="w-full pl-11 pr-28 py-3 rounded-2xl bg-white/[0.05] border border-white/10 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-teal-400/50 transition"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setIsSearchFocused(true);
                    }}
                    className="absolute right-20 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSearching}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 rounded-xl bg-white/12 hover:bg-white/20 text-xs font-medium text-white transition cursor-pointer"
                >
                  {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Найти'}
                </button>
              </form>

              {/* ВЫПАДАЮЩИЕ ПОДСКАЗКИ ДО ВВОДА И ВО ВРЕМЯ ВВОДА */}
              {isSearchFocused && (
                <div className="absolute left-0 right-0 mt-2 rounded-2xl bg-[#121218]/98 backdrop-blur-2xl border border-white/15 shadow-2xl overflow-hidden z-40">
                  {!searchQuery.trim() && recentSearches.length > 0 && (
                    <div className="p-2 border-b border-white/10">
                      <span className="text-[10px] uppercase tracking-wider text-white/40 px-3 py-1 block">
                        Недавние запросы
                      </span>
                      {recentSearches.map((item) => (
                        <div
                          key={`recent-${item}`}
                          onClick={() => executeSearch(item)}
                          className="flex items-center justify-between px-3 py-2 rounded-xl hover:bg-white/[0.08] text-xs text-white/85 cursor-pointer transition"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Clock className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <span className="truncate">{item}</span>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => removeRecentSearch(item, e)}
                            className="p-1 text-white/35 hover:text-white cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="p-2">
                    <span className="text-[10px] uppercase tracking-wider text-white/40 px-3 py-1 block">
                      {searchQuery.trim() ? 'Подсказки' : 'Популярное сейчас'}
                    </span>
                    {suggestions.slice(0, 8).map((sug) => (
                      <div
                        key={`sug-${sug}`}
                        onClick={() => executeSearch(sug)}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-white/[0.08] text-xs text-white/90 cursor-pointer transition"
                      >
                        <TrendingUp className="w-3.5 h-3.5 text-teal-300 shrink-0" />
                        <span className="truncate">{sug}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 space-y-6">
          {/* ==================== РАЗДЕЛ 1: ПОИСК И ОБЗОР ==================== */}
          {section === 'explore' && (
            <>
              {collectionView ? (
                <div className="space-y-6">
                  <button
                    onClick={() => setCollectionView(null)}
                    className="inline-flex items-center gap-2 text-xs text-white/65 hover:text-white bg-white/[0.06] px-3.5 py-2 rounded-xl border border-white/10 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Назад к результатам поиска</span>
                  </button>

                  <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 p-6 rounded-3xl bg-white/[0.04] border border-white/10">
                    <div
                      className={`w-36 h-36 sm:w-44 sm:h-44 overflow-hidden bg-white/10 border border-white/15 shrink-0 flex items-center justify-center shadow-2xl ${
                        collectionView.type === 'artist' ? 'rounded-full' : 'rounded-2xl'
                      }`}
                    >
                      {collectionView.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={collectionView.thumbnail}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : collectionView.type === 'artist' ? (
                        <User className="w-14 h-14 text-white/30" />
                      ) : (
                        <Disc className="w-14 h-14 text-white/30" />
                      )}
                    </div>

                    <div className="text-center sm:text-left flex-1 min-w-0">
                      <span className="text-[11px] uppercase tracking-widest text-teal-300 font-semibold">
                        {collectionView.type === 'artist' ? 'Артист' : 'Альбом'}
                      </span>
                      <h1 className="text-2xl sm:text-3xl font-bold text-white mt-1 break-words">
                        {collectionView.title}
                      </h1>
                      {collectionView.subtitle && (
                        <p className="text-sm text-white/60 mt-1">{collectionView.subtitle}</p>
                      )}

                      {collectionView.tracks.length > 0 && (
                        <div className="mt-4 flex flex-wrap items-center justify-center sm:justify-start gap-2.5">
                          <button
                            onClick={() =>
                              playTrack(collectionView.tracks[0], collectionView.tracks, false)
                            }
                            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-teal-400 text-zinc-950 font-semibold text-sm hover:scale-105 transition cursor-pointer shadow-lg"
                          >
                            <Play className="w-4 h-4 fill-zinc-950" />
                            <span>Слушать всё</span>
                          </button>

                          <button
                            onClick={() => playShuffledList(collectionView.tracks)}
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white font-medium text-sm transition cursor-pointer"
                          >
                            <Shuffle className="w-4 h-4 text-teal-300" />
                            <span>Перемешать</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Вкладки у исполнителя: Всё / Все песни / Альбомы и релизы */}
                  {collectionView.type === 'artist' && !collectionView.loading && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                      {[
                        { id: 'all', label: 'Всё' },
                        { id: 'tracks', label: `Все песни (${collectionView.tracks.length})` },
                        {
                          id: 'albums',
                          label: `Альбомы и синглы (${collectionView.albums?.length || 0})`,
                        },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          onClick={() => setArtistTab(tab.id as typeof artistTab)}
                          className={`px-4 py-2 rounded-full text-xs font-medium border transition shrink-0 cursor-pointer ${
                            artistTab === tab.id
                              ? 'bg-white text-zinc-950 border-white'
                              : 'bg-white/[0.04] border-white/10 text-white/70 hover:text-white'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {collectionView.loading ? (
                    <div className="flex items-center justify-center py-16 text-white/50 gap-2">
                      <Loader2 className="w-5 h-5 animate-spin text-teal-400" />
                      <span>Загружаю каталог...</span>
                    </div>
                  ) : (
                    <>
                      {/* Блок альбомов и синглов артиста */}
                      {collectionView.type === 'artist' &&
                        (artistTab === 'all' || artistTab === 'albums') &&
                        collectionView.albums &&
                        collectionView.albums.length > 0 && (
                          <div className="space-y-3">
                            <h2 className="text-base font-semibold text-white">
                              Альбомы и релизы ({collectionView.albums.length})
                            </h2>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                              {(artistTab === 'all'
                                ? collectionView.albums.slice(0, 8)
                                : collectionView.albums
                              ).map((alb) => (
                                <div
                                  key={alb.id}
                                  onClick={() => openAlbum(alb)}
                                  className="group p-3 rounded-2xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 transition cursor-pointer"
                                >
                                  <div className="aspect-square rounded-xl overflow-hidden bg-white/10 mb-2.5 flex items-center justify-center">
                                    {alb.thumbnail ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={alb.thumbnail}
                                        alt=""
                                        className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                                      />
                                    ) : (
                                      <Disc className="w-10 h-10 text-white/30" />
                                    )}
                                  </div>
                                  <p className="text-xs font-semibold text-white truncate">
                                    {alb.title}
                                  </p>
                                  <p className="text-[11px] text-white/50 truncate mt-0.5">
                                    {[alb.type, alb.year].filter(Boolean).join(' • ') || alb.artist}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      {/* Блок всех песен артиста или треклист альбома */}
                      {(collectionView.type === 'album' ||
                        artistTab === 'all' ||
                        artistTab === 'tracks') &&
                        collectionView.tracks.length > 0 && (
                          <div className="space-y-2">
                            <h2 className="text-base font-semibold text-white mb-3">
                              {collectionView.type === 'artist'
                                ? `Все песни (${collectionView.tracks.length})`
                                : `Треки (${collectionView.tracks.length})`}
                            </h2>
                            {collectionView.tracks.map((t, i) =>
                              renderTrackRow(t, collectionView.tracks, i)
                            )}
                          </div>
                        )}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {[
                      { id: 'all', label: 'Всё' },
                      { id: 'tracks', label: `Треки (${foundTracks.length})` },
                      { id: 'albums', label: `Альбомы (${foundAlbums.length})` },
                      { id: 'artists', label: `Артисты (${foundArtists.length})` },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setSearchTab(tab.id as typeof searchTab)}
                        className={`px-4 py-2 rounded-full text-xs font-medium border transition shrink-0 cursor-pointer ${
                          searchTab === tab.id
                            ? 'bg-white text-zinc-950 border-white'
                            : 'bg-white/[0.04] border-white/10 text-white/70 hover:text-white'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {foundTracks.length === 0 &&
                  foundAlbums.length === 0 &&
                  foundArtists.length === 0 ? (
                    <div className="text-center py-14 rounded-3xl bg-white/[0.02] border border-white/[0.07] px-4 space-y-5">
                      <div>
                        <Search className="w-10 h-10 text-white/20 mx-auto mb-3" />
                        <p className="text-sm text-white/80 font-medium">
                          Выбери подсказку или введи имя артиста, песню или альбом
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl mx-auto">
                        {suggestions.slice(0, 10).map((tag) => (
                          <button
                            key={`chip-${tag}`}
                            type="button"
                            onClick={() => executeSearch(tag)}
                            className="px-3.5 py-2 rounded-full bg-white/[0.05] hover:bg-teal-500/20 border border-white/10 hover:border-teal-400/40 text-xs text-white/80 hover:text-teal-200 transition cursor-pointer"
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {(searchTab === 'all' || searchTab === 'artists') &&
                        foundArtists.length > 0 && (
                          <section className="space-y-3">
                            <h2 className="text-base font-semibold text-white">Артисты</h2>
                            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3.5">
                              {(searchTab === 'all'
                                ? foundArtists.slice(0, 6)
                                : foundArtists
                              ).map((artist) => (
                                <div
                                  key={artist.id}
                                  onClick={() => openArtist(artist)}
                                  className="p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.08] flex flex-col items-center text-center transition cursor-pointer"
                                >
                                  <div className="w-20 h-20 rounded-full overflow-hidden bg-white/10 mb-2.5 border border-white/15 flex items-center justify-center">
                                    {artist.thumbnail ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={artist.thumbnail}
                                        alt=""
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <User className="w-8 h-8 text-white/40" />
                                    )}
                                  </div>
                                  <p className="text-xs font-semibold text-white truncate w-full">
                                    {artist.name}
                                  </p>
                                  <span className="text-[10px] text-white/45 mt-0.5">Артист</span>
                                </div>
                              ))}
                            </div>
                          </section>
                        )}

                      {(searchTab === 'all' || searchTab === 'albums') &&
                        foundAlbums.length > 0 && (
                          <section className="space-y-3">
                            <h2 className="text-base font-semibold text-white">Альбомы</h2>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                              {(searchTab === 'all'
                                ? foundAlbums.slice(0, 4)
                                : foundAlbums
                              ).map((album) => (
                                <div
                                  key={album.id}
                                  onClick={() => openAlbum(album)}
                                  className="group p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.08] transition cursor-pointer"
                                >
                                  <div className="relative aspect-square rounded-xl overflow-hidden bg-white/10 mb-3 flex items-center justify-center">
                                    {album.thumbnail ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={album.thumbnail}
                                        alt=""
                                        className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                                      />
                                    ) : (
                                      <Disc className="w-10 h-10 text-white/30" />
                                    )}
                                  </div>
                                  <p className="text-sm font-semibold text-white truncate">
                                    {album.title}
                                  </p>
                                  <p className="text-xs text-white/50 truncate mt-0.5">
                                    {album.artist}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </section>
                        )}

                      {(searchTab === 'all' || searchTab === 'tracks') &&
                        foundTracks.length > 0 && (
                          <section className="space-y-2.5">
                            <h2 className="text-base font-semibold text-white">Треки</h2>
                            {(searchTab === 'all' ? foundTracks.slice(0, 12) : foundTracks).map(
                              (track, i) => renderTrackRow(track, foundTracks, i)
                            )}
                          </section>
                        )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ==================== РАЗДЕЛ 2: ПЛЕЙЛИСТЫ ==================== */}
          {section === 'playlists' && (
            <div className="space-y-6">
              {activePlaylist ? (
                <div className="space-y-6">
                  <button
                    onClick={() => {
                      setSelectedPlaylistId(null);
                      setSelectedMood('all');
                    }}
                    className="inline-flex items-center gap-2 text-xs text-white/65 hover:text-white bg-white/[0.06] px-3.5 py-2 rounded-xl border border-white/10 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Ко всем плейлистам</span>
                  </button>

                  {/* Шапка плейлиста */}
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-6 rounded-3xl bg-gradient-to-r from-violet-600/20 to-teal-500/20 border border-white/15">
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 rounded-2xl overflow-hidden bg-white/10 flex items-center justify-center shrink-0">
                        {activePlaylist.tracks[0]?.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={activePlaylist.tracks[0].thumbnail}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <ListMusic className="w-8 h-8 text-teal-300" />
                        )}
                      </div>
                      <div>
                        <span className="text-[11px] uppercase tracking-wider text-teal-300">
                          Плейлист
                        </span>
                        <h1 className="text-2xl font-bold text-white">{activePlaylist.name}</h1>
                        <p className="text-xs text-white/60 mt-1">
                          {selectedMood === 'all'
                            ? `${activePlaylist.tracks.length} треков`
                            : `Показано ${visiblePlaylistTracks.length} из ${activePlaylist.tracks.length} треков`}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {visiblePlaylistTracks.length > 0 && (
                        <>
                          <button
                            onClick={() =>
                              playTrack(visiblePlaylistTracks[0], visiblePlaylistTracks, false)
                            }
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-teal-400 text-zinc-950 font-semibold text-xs hover:scale-105 transition cursor-pointer"
                          >
                            <Play className="w-4 h-4 fill-zinc-950" />
                            <span>Играть</span>
                          </button>

                          <button
                            onClick={() => playShuffledList(visiblePlaylistTracks)}
                            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 text-white font-medium text-xs transition cursor-pointer"
                          >
                            <Shuffle className="w-3.5 h-3.5 text-teal-300" />
                            <span>Перемешать</span>
                          </button>
                        </>
                      )}

                      <button
                        onClick={() => {
                          deletePlaylist(activePlaylist.id);
                          setSelectedPlaylistId(null);
                          setSelectedMood('all');
                        }}
                        title="Удалить плейлист"
                        className="p-2.5 rounded-full bg-white/10 hover:bg-rose-500/25 text-white/70 hover:text-rose-300 transition cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Фильтр по настроению */}
                  <MoodFilterBar
                    tracks={activePlaylist.tracks}
                    selectedMood={selectedMood}
                    onSelectMood={handleMoodChange}
                  />

                  {/* Список треков в плейлисте */}
                  {visiblePlaylistTracks.length > 0 && (
                    <div className="space-y-2">
                      {visiblePlaylistTracks.map((t, i) =>
                        renderTrackRow(t, visiblePlaylistTracks, i, activePlaylist.id)
                      )}
                    </div>
                  )}

                  {/* УДОБНОЕ ДОБАВЛЕНИЕ ПЕСЕН ПРЯМО ВНУТРИ ПЛЕЙЛИСТА */}
                  <div className="p-5 rounded-3xl bg-white/[0.03] border border-white/10 space-y-4">
                    <div>
                      <h2 className="text-sm font-semibold text-white">
                        Добавить песни в «{activePlaylist.name}»
                      </h2>
                      <p className="text-xs text-white/45 mt-0.5">
                        Найди песню ниже или добавь из своего «Избранного» в один клик
                      </p>
                    </div>

                    <form onSubmit={handleInPlaylistSearch} className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="w-4 h-4 text-white/40 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={inPlaylistQuery}
                          onChange={(e) => setInPlaylistQuery(e.target.value)}
                          placeholder="Введи название трека или артиста..."
                          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder:text-white/35 focus:outline-none focus:border-teal-400/50"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleInPlaylistSearch()}
                        disabled={isInPlaylistSearching}
                        className="px-4 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 text-xs font-medium text-white transition cursor-pointer shrink-0"
                      >
                        {isInPlaylistSearching ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          'Найти'
                        )}
                      </button>
                    </form>

                    {(() => {
                      const listSuggestions =
                        inPlaylistResults.length > 0 ? inPlaylistResults : likedTracks.slice(0, 8);
                      if (listSuggestions.length === 0) return null;

                      return (
                        <div className="space-y-2 pt-1">
                          <span className="text-[11px] uppercase tracking-wider text-white/40 block">
                            {inPlaylistResults.length > 0
                              ? 'Результаты поиска'
                              : 'Быстро добавить из Избранного'}
                          </span>
                          {listSuggestions.map((track) => {
                            const alreadyIn = activePlaylist.tracks.some((t) => t.id === track.id);
                            return (
                              <div
                                key={`add-${track.id}`}
                                className="flex items-center justify-between gap-3 p-2.5 rounded-2xl bg-white/[0.025] border border-white/[0.07]"
                              >
                                <div
                                  onClick={() => playTrack(track, listSuggestions)}
                                  className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                                >
                                  <div className="w-10 h-10 rounded-xl overflow-hidden bg-white/10 shrink-0">
                                    {track.thumbnail && (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={track.thumbnail}
                                        alt=""
                                        className="w-full h-full object-cover"
                                      />
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-white truncate">
                                      {track.title}
                                    </p>
                                    <p className="text-[11px] text-white/50 truncate">
                                      {track.artist}
                                    </p>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => toggleTrackInPlaylist(activePlaylist.id, track)}
                                  className={`px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 border transition cursor-pointer shrink-0 ${
                                    alreadyIn
                                      ? 'bg-teal-500/20 border-teal-400/40 text-teal-200'
                                      : 'bg-white/10 hover:bg-white/20 border-white/15 text-white'
                                  }`}
                                >
                                  {alreadyIn ? (
                                    <>
                                      <Check className="w-3.5 h-3.5" />
                                      <span>Добавлено</span>
                                    </>
                                  ) : (
                                    <>
                                      <Plus className="w-3.5 h-3.5" />
                                      <span>Добавить</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <h1 className="text-xl font-bold text-white">Мои плейлисты</h1>

                    <form onSubmit={handleCreatePlaylistForm} className="flex gap-2">
                      <input
                        type="text"
                        value={newPlaylistName}
                        onChange={(e) => setNewPlaylistName(e.target.value)}
                        placeholder="Название нового плейлиста..."
                        className="px-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder:text-white/35 focus:outline-none focus:border-teal-400/50"
                      />
                      <button
                        type="button"
                        onClick={() => handleCreatePlaylistForm()}
                        className="px-4 py-2.5 rounded-xl bg-teal-400 text-zinc-950 font-semibold text-xs flex items-center gap-1.5 hover:opacity-90 transition cursor-pointer shrink-0"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Создать</span>
                      </button>
                    </form>
                  </div>

                  {/* ИМПОРТ ПЛЕЙЛИСТА ИЗ SPOTIFY / YOUTUBE MUSIC / YOUTUBE / SOUNDCLOUD */}
                  <div className="p-4 sm:p-5 rounded-3xl bg-white/[0.03] border border-white/10 space-y-3">
                    <div className="flex items-center gap-2">
                      <Link2 className="w-4 h-4 text-teal-300 shrink-0" />
                      <h2 className="text-sm font-semibold text-white">
                        Импорт плейлиста по ссылке
                      </h2>
                    </div>
                    <p className="text-xs text-white/50">
                      Вставь публичную ссылку на плейлист или альбом из <b>Spotify</b>,{' '}
                      <b>YouTube Music</b>, <b>YouTube</b> или <b>SoundCloud</b>.
                    </p>

                    <form onSubmit={handleImportPlaylist} className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={importUrl}
                        onChange={(e) => setImportUrl(e.target.value)}
                        placeholder="https://open.spotify.com/playlist/... или https://music.youtube.com/playlist?list=..."
                        className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder:text-white/35 focus:outline-none focus:border-teal-400/50"
                      />
                      <button
                        type="button"
                        onClick={() => handleImportPlaylist()}
                        disabled={isImporting || !importUrl.trim()}
                        className="px-5 py-2.5 rounded-xl bg-violet-500/25 hover:bg-violet-500/35 border border-violet-400/40 text-xs font-semibold text-violet-200 flex items-center justify-center gap-2 disabled:opacity-45 transition cursor-pointer shrink-0"
                      >
                        {isImporting ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Импортирую...</span>
                          </>
                        ) : (
                          <span>Импортировать</span>
                        )}
                      </button>
                    </form>

                    {importError && <p className="text-xs text-rose-400">{importError}</p>}
                  </div>

                  {playlists.length === 0 ? (
                    <div className="text-center py-14 rounded-3xl bg-white/[0.02] border border-white/[0.07] text-xs text-white/45">
                      Создай свой первый плейлист выше или импортируй готовый из Spotify / YouTube Music.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                      {playlists.map((pl) => (
                        <div
                          key={pl.id}
                          onClick={() => {
                            setSelectedPlaylistId(pl.id);
                            setInPlaylistQuery('');
                            setInPlaylistResults([]);
                            setSelectedMood('all');
                          }}
                          className="p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 transition cursor-pointer"
                        >
                          <div className="aspect-square rounded-xl overflow-hidden bg-gradient-to-br from-violet-600/30 to-teal-500/30 mb-3 flex items-center justify-center">
                            {pl.tracks[0]?.thumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={pl.tracks[0].thumbnail}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ListMusic className="w-10 h-10 text-white/40" />
                            )}
                          </div>
                          <p className="text-sm font-semibold text-white truncate">{pl.name}</p>
                          <p className="text-xs text-white/50 mt-0.5">{pl.tracks.length} треков</p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ==================== РАЗДЕЛ 3: ИЗБРАННОЕ ==================== */}
          {section === 'liked' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-xl font-bold text-white">Избранные треки</h1>
                {likedTracks.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => playTrack(likedTracks[0], likedTracks, false)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-pink-500/20 border border-pink-400/40 text-pink-200 text-xs font-medium cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-pink-200" />
                      <span>Играть все</span>
                    </button>
                    <button
                      onClick={() => playShuffledList(likedTracks)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 border border-white/15 text-white text-xs font-medium cursor-pointer"
                    >
                      <Shuffle className="w-3.5 h-3.5 text-teal-300" />
                      <span>Перемешать</span>
                    </button>
                  </div>
                )}
              </div>

              {likedTracks.length === 0 ? (
                <div className="text-center py-16 rounded-3xl bg-white/[0.02] border border-white/[0.07] text-xs text-white/45">
                  Ставь лайки понравившимся песням — они сохранятся здесь.
                </div>
              ) : (
                <div className="space-y-2">
                  {likedTracks.map((t, i) => renderTrackRow(t, likedTracks, i))}
                </div>
              )}
            </div>
          )}

          {/* ==================== РАЗДЕЛ 4: ОФЛАЙН ==================== */}
          {section === 'offline' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-xl font-bold text-white">Скачанные треки (Офлайн)</h1>
                {savedTracks.length > 0 && (
                  <button
                    onClick={() => playShuffledList(savedTracks)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 border border-white/15 text-white text-xs font-medium cursor-pointer"
                  >
                    <Shuffle className="w-3.5 h-3.5 text-teal-300" />
                    <span>Перемешать</span>
                  </button>
                )}
              </div>

              {savedTracks.length === 0 ? (
                <div className="text-center py-16 rounded-3xl bg-white/[0.02] border border-white/[0.07] text-xs text-white/45">
                  Скачай трек кнопкой загрузки, чтобы слушать без интернета.
                </div>
              ) : (
                <div className="space-y-2">
                  {savedTracks.map((t, i) => renderTrackRow(t, savedTracks, i))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* НИЖНЯЯ НАВИГАЦИЯ ДЛЯ ТЕЛЕФОНА */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 h-14 bg-[#0c0c10]/95 backdrop-blur-2xl border-t border-white/10 grid grid-cols-4 z-30">
        {[
          { id: 'explore', label: 'Поиск', icon: Search },
          { id: 'playlists', label: 'Плейлисты', icon: ListMusic },
          { id: 'liked', label: 'Избранное', icon: Heart },
          { id: 'offline', label: 'Офлайн', icon: Download },
        ].map((item) => {
          const Icon = item.icon;
          const active = section === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                setSection(item.id as typeof section);
                setSelectedPlaylistId(null);
                setCollectionView(null);
                setSelectedMood('all');
              }}
              className={`flex flex-col items-center justify-center gap-0.5 text-[10px] ${
                active ? 'text-teal-300 font-semibold' : 'text-white/50'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* АДАПТИВНЫЙ ПЛЕЕР (ПК + ТЕЛЕФОН) */}
      <PlayerBar
        track={currentTrack}
        isPlaying={isPlaying}
        isLoading={isLoading}
        isShuffled={isShuffled}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        isLiked={currentTrack ? likedTracks.some((t) => t.id === currentTrack.id) : false}
        isSaved={currentTrack ? isSaved(currentTrack.id) : false}
        isDownloading={currentTrack ? Boolean(downloadingIds[currentTrack.id]) : false}
        sleepSecondsLeft={sleepSecondsLeft}
        onTogglePlay={togglePlay}
        onToggleShuffle={toggleShuffle}
        onPrev={handlePrevTrack}
        onNext={handleNextTrack}
        onSeek={seek}
        onVolumeChange={setVolume}
        onToggleLike={() => currentTrack && toggleLike(currentTrack)}
        onDownload={() => currentTrack && downloadTrack(currentTrack)}
        onAddToPlaylist={() => currentTrack && setPlaylistModalTrack(currentTrack)}
        onOpenDrawer={setActiveDrawer}
      />

      {/* Окно добавления трека в плейлист */}
      <PlaylistModal
        track={playlistModalTrack}
        playlists={playlists}
        onClose={() => setPlaylistModalTrack(null)}
        onCreatePlaylist={createPlaylist}
        onToggleTrack={toggleTrackInPlaylist}
      />

      {/* Выезжающие шторки (Текст, Эквалайзер, Таймер сна) */}
      <BottomDrawers
        activeDrawer={activeDrawer}
        onClose={() => setActiveDrawer(null)}
        lyricsLines={lyricsLines}
        plainLyrics={plainLyrics}
        activeLyricIndex={activeLyricIndex}
        lyricsLoading={lyricsLoading}
        eqGains={eqGains}
        activePreset={activePreset}
        onUpdateBandGain={updateBandGain}
        onApplyPreset={applyPreset}
        sleepSecondsLeft={sleepSecondsLeft}
        onStartSleep={startSleep}
        onCancelSleep={cancelSleep}
      />
    </div>
  );
}