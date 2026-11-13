// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import yts from 'yt-search';
import { Track, Album, Artist, WAVE_SEEDS } from '@/lib/instances';

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
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artistName = searchParams.get('artist')?.trim();

  // 1. Открытие конкретного альбома / плейлиста
  if (listId) {
    try {
      const playlist = await yts({ listId });
      const tracks = mapVideosToTracks(playlist.videos || []);
      return NextResponse.json({
        title: playlist.title || 'Альбом',
        tracks,
      });
    } catch (err) {
      console.error('Ошибка загрузки альбома:', err);
      return NextResponse.json({ tracks: [] }, { status: 500 });
    }
  }

  // 2. Открытие страницы артиста (его лучшие треки и альбомы)
  if (artistName) {
    try {
      const [mainRes, albumRes] = await Promise.all([
        yts(artistName),
        yts(`${artistName} full album`),
      ]);
      const tracks = mapVideosToTracks(mainRes.videos || []).slice(0, 20);
      const albums = mapPlaylistsToAlbums([
        ...(mainRes.playlists || []),
        ...(albumRes.playlists || []),
      ]).slice(0, 12);

      return NextResponse.json({ tracks, albums });
    } catch (err) {
      console.error('Ошибка загрузки артиста:', err);
      return NextResponse.json({ tracks: [], albums: [] }, { status: 500 });
    }
  }

  // 3. Прямая ссылка на трек YouTube
  const directId = extractVideoId(rawQuery);
  if (directId) {
    try {
      const video = await yts({ videoId: directId });
      return NextResponse.json({
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
      });
    } catch {
      return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 404 });
    }
  }

  // 4. Полноценный поиск: Треки + Альбомы + Артисты
  const query =
    mode === 'wave' || !rawQuery
      ? WAVE_SEEDS[Math.floor(Math.random() * WAVE_SEEDS.length)]
      : rawQuery;

  try {
    const [mainRes, albumRes] = await Promise.all([
      yts(query),
      mode === 'wave' ? Promise.resolve({ playlists: [] }) : yts(`${query} album`),
    ]);

    const tracks = mapVideosToTracks(mainRes.videos || []).slice(0, 25);
    const albums = mapPlaylistsToAlbums([
      ...(mainRes.playlists || []),
      ...(albumRes.playlists || []),
    ]).slice(0, 16);

    // Собираем артистов из каналов YouTube, а если их мало — дополняем из авторов найденных треков
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

    return NextResponse.json({
      tracks,
      albums,
      artists: Array.from(artistMap.values()),
    });
  } catch (err) {
    console.error('Ошибка поиска:', err);
    return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 500 });
  }
}