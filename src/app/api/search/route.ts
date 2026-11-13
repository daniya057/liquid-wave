// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import yts from 'yt-search';
import { Track, Album, Artist, WAVE_SEEDS } from '@/lib/instances';

// Кэш в оперативной памяти сервера (живет 30 минут)
const CACHE_TTL = 30 * 60 * 1000;
const searchCache = new Map<string, { data: any; expires: number }>();

function getCached(key: string) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: any) {
  // Ограничиваем размер кэша до 300 запросов, чтобы не забивать 512 МБ RAM на Render
  if (searchCache.size >= 300) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }
  searchCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// Вспомогательная функция: не ждем вторичный запрос дольше 2.5 секунд
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function extractVideoId(input: string): string | null {
  const match = input.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function mapVideosToTracks(videos: any[]): Track[] {
  const seen = new Set<string>();
  const tracks: Track[] = [];

  for (const v of videos || []) {
    const id = v.videoId;
    const sec = v.seconds ?? v.duration?.seconds ?? 0;
    if (!id || seen.has(id) || (sec > 0 && (sec < 40 || sec > 900))) continue;

    seen.add(id);
    tracks.push({
      id,
      title: v.title || 'Без названия',
      artist: v.author?.name || 'Исполнитель',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      duration: sec,
    });
  }
  return tracks;
}

function mapPlaylistsToAlbums(playlists: any[]): Album[] {
  const seen = new Set<string>();
  const albums: Album[] = [];

  for (const p of playlists || []) {
    if (!p.listId || seen.has(p.listId)) continue;
    seen.add(p.listId);
    albums.push({
      id: p.listId,
      title: p.title || 'Альбом',
      artist: p.author?.name || 'Исполнитель',
      thumbnail: p.thumbnail || '',
      trackCount: p.videoCount || undefined,
    });
  }
  return albums;
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artistName = searchParams.get('artist')?.trim();

  console.log(`[SEARCH] Запрос: q="${rawQuery}" mode="${mode || ''}" listId="${listId || ''}" artist="${artistName || ''}"`);

  // 1. Открытие конкретного альбома / плейлиста
  if (listId) {
    const cacheKey = `list:${listId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[SEARCH] Кэш-хит альбома (${Date.now() - startTime}ms)`);
      return NextResponse.json(cached);
    }

    try {
      const playlist = await yts({ listId });
      const tracks = mapVideosToTracks(playlist.videos || []);
      const result = { title: playlist.title || 'Альбом', tracks };
      setCached(cacheKey, result);
      console.log(`[SEARCH] Альбом загружен: ${tracks.length} треков (${Date.now() - startTime}ms)`);
      return NextResponse.json(result);
    } catch (err) {
      console.error('[SEARCH] Ошибка загрузки альбома:', err);
      return NextResponse.json({ tracks: [] }, { status: 500 });
    }
  }

  // 2. Открытие страницы артиста
  if (artistName) {
    const cacheKey = `artist:${artistName.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[SEARCH] Кэш-хит артиста (${Date.now() - startTime}ms)`);
      return NextResponse.json(cached);
    }

    try {
      const [mainRes, albumRes] = await Promise.all([
        yts(artistName),
        withTimeout(yts(`${artistName} full album`), 2500, { playlists: [] }),
      ]);
      const tracks = mapVideosToTracks(mainRes.videos || []).slice(0, 20);
      const albums = mapPlaylistsToAlbums([
        ...(mainRes.playlists || []),
        ...(albumRes.playlists || []),
      ]).slice(0, 12);

      const result = { tracks, albums };
      setCached(cacheKey, result);
      console.log(`[SEARCH] Артист загружен: ${tracks.length} треков (${Date.now() - startTime}ms)`);
      return NextResponse.json(result);
    } catch (err) {
      console.error('[SEARCH] Ошибка загрузки артиста:', err);
      return NextResponse.json({ tracks: [], albums: [] }, { status: 500 });
    }
  }

  // 3. Прямая ссылка на трек YouTube
  const directId = extractVideoId(rawQuery);
  if (directId) {
    const cacheKey = `video:${directId}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    try {
      const video = await yts({ videoId: directId });
      const result = {
        tracks: [
          {
            id: video.videoId,
            title: video.title || 'Без названия',
            artist: video.author?.name || 'Исполнитель',
            thumbnail: video.thumbnail || '',
            duration: video.seconds || 0,
          },
        ],
        albums: [],
        artists: [],
      };
      setCached(cacheKey, result);
      console.log(`[SEARCH] Прямой трек загружен (${Date.now() - startTime}ms)`);
      return NextResponse.json(result);
    } catch {
      return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 404 });
    }
  }

  // 4. Полноценный поиск: Треки + Альбомы + Артисты
  const isWave = mode === 'wave' || !rawQuery;
  const query = isWave
    ? WAVE_SEEDS[Math.floor(Math.random() * WAVE_SEEDS.length)]
    : rawQuery;

  const cacheKey = `q:${query.toLowerCase()}`;
  if (!isWave) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[SEARCH] Мгновенный ответ из кэша для "${query}" (${Date.now() - startTime}ms)`);
      return NextResponse.json(cached);
    }
  }

  try {
    const [mainRes, albumRes] = await Promise.all([
      yts(query),
      isWave
        ? Promise.resolve({ playlists: [] })
        : withTimeout(yts(`${query} album`), 2500, { playlists: [] }),
    ]);

    const tracks = mapVideosToTracks(mainRes.videos || []).slice(0, 25);
    const albums = mapPlaylistsToAlbums([
      ...(mainRes.playlists || []),
      ...(albumRes.playlists || []),
    ]).slice(0, 16);

    const artistMap = new Map<string, Artist>();
    for (const ch of mainRes.channels || []) {
      if (!ch.name) continue;
      const key = ch.name.toLowerCase();
      if (!artistMap.has(key)) {
        artistMap.set(key, {
          id: ch.url || ch.name,
          name: ch.name,
          thumbnail: ch.image || ch.thumbnail || '',
          subscribers: ch.subCountLabel || undefined,
        });
      }
    }

    for (const t of tracks) {
      const cleanAuthor = t.artist.replace(/\s*-\s*Topic$/i, '').trim();
      const key = cleanAuthor.toLowerCase();
      if (cleanAuthor && !artistMap.has(key) && artistMap.size < 12) {
        artistMap.set(key, {
          id: cleanAuthor,
          name: cleanAuthor,
          thumbnail: t.thumbnail,
        });
      }
    }

    const result = {
      tracks,
      albums,
      artists: Array.from(artistMap.values()),
    };

    if (!isWave && tracks.length > 0) {
      setCached(cacheKey, result);
    }

    console.log(`[SEARCH] Найдено ${tracks.length} треков для "${query}" за ${Date.now() - startTime}ms`);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[SEARCH] Ошибка поиска:', err);
    return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 500 });
  }
}