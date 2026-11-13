// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import yts from 'yt-search';
import { Track, Album, Artist, WAVE_SEEDS } from '@/lib/instances';

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
  if (searchCache.size >= 300) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }
  searchCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

function parseDurationToSeconds(text?: string): number {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

async function fastYoutubeSearch(query: string): Promise<{ tracks: Track[]; albums: Album[] }> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20241126.01.00',
          hl: 'ru',
          gl: 'RU',
        },
      },
      query,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`InnerTube status ${res.status}`);
  const json = await res.json();

  const sections =
    json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

  const tracks: Track[] = [];
  const albums: Album[] = [];
  const seenTracks = new Set<string>();
  const seenAlbums = new Set<string>();

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      if (item.videoRenderer) {
        const v = item.videoRenderer;
        const id = v.videoId;
        const sec = parseDurationToSeconds(v.lengthText?.simpleText);
        if (!id || seenTracks.has(id) || (sec > 0 && (sec < 40 || sec > 900))) continue;

        seenTracks.add(id);
        tracks.push({
          id,
          title: v.title?.runs?.[0]?.text || 'Без названия',
          artist: v.ownerText?.runs?.[0]?.text || 'Исполнитель',
          thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          duration: sec,
        });
      } else if (item.playlistRenderer) {
        const p = item.playlistRenderer;
        const listId = p.playlistId;
        if (!listId || seenAlbums.has(listId)) continue;

        seenAlbums.add(listId);
        albums.push({
          id: listId,
          title: p.title?.simpleText || 'Альбом',
          artist: p.shortBylineText?.runs?.[0]?.text || 'Исполнитель',
          thumbnail: p.thumbnails?.[0]?.thumbnails?.[0]?.url || '',
          trackCount: Number(p.videoCount) || undefined,
        });
      }
    }
  }

  return { tracks, albums };
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

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artistName = searchParams.get('artist')?.trim();

  console.log(`[SEARCH] Запрос: q="${rawQuery}" mode="${mode || ''}" listId="${listId || ''}" artist="${artistName || ''}"`);

  // 1. Открытие альбома / плейлиста
  if (listId) {
    const cacheKey = `list:${listId}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    try {
      const playlist = await yts({ listId });
      const tracks = mapVideosToTracks(playlist.videos || []);
      const result = { title: playlist.title || 'Альбом', tracks };
      setCached(cacheKey, result);
      console.log(`[SEARCH] Альбом загружен за ${Date.now() - startTime}ms`);
      return NextResponse.json(result);
    } catch (err) {
      console.error('[SEARCH] Ошибка альбома:', err);
      return NextResponse.json({ tracks: [] }, { status: 500 });
    }
  }

  // 2. Страница артиста
  if (artistName) {
    const cacheKey = `artist:${artistName.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    try {
      const { tracks, albums } = await fastYoutubeSearch(`${artistName} music`);
      const result = { tracks: tracks.slice(0, 20), albums: albums.slice(0, 12) };
      setCached(cacheKey, result);
      console.log(`[SEARCH] Артист "${artistName}" загружен за ${Date.now() - startTime}ms`);
      return NextResponse.json(result);
    } catch (err) {
      console.error('[SEARCH] Ошибка артиста:', err);
      return NextResponse.json({ tracks: [], albums: [] }, { status: 500 });
    }
  }

  // 3. Прямая ссылка на трек
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
      return NextResponse.json(result);
    } catch {
      return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 404 });
    }
  }

  // 4. Основной поиск
  const isWave = mode === 'wave' || !rawQuery;
  const query = isWave
    ? WAVE_SEEDS[Math.floor(Math.random() * WAVE_SEEDS.length)]
    : rawQuery;

  const cacheKey = `q:${query.toLowerCase()}`;
  if (!isWave) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[SEARCH] Из кэша "${query}" за ${Date.now() - startTime}ms`);
      return NextResponse.json(cached);
    }
  }

  try {
    let tracks: Track[] = [];
    let albums: Album[] = [];

    try {
      const fastRes = await fastYoutubeSearch(query);
      tracks = fastRes.tracks.slice(0, 25);
      albums = fastRes.albums.slice(0, 16);
    } catch {
      const fallback = await yts(query);
      tracks = mapVideosToTracks(fallback.videos || []).slice(0, 25);
    }

    const artistMap = new Map<string, Artist>();
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