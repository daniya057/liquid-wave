// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';

let cachedHost = 'https://discoveryprovider.audius.co';
let hostExpires = 0;

async function getAudiusHost(): Promise<string> {
  if (Date.now() < hostExpires) return cachedHost;
  try {
    const res = await fetch('https://api.audius.co', { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    if (Array.isArray(json?.data) && json.data.length > 0) {
      cachedHost = json.data[Math.floor(Math.random() * json.data.length)];
      hostExpires = Date.now() + 10 * 60 * 1000;
    }
  } catch {}
  return cachedHost;
}

function mapTracks(items: any[]) {
  const seen = new Set<string>();
  const tracks = [];
  for (const item of items || []) {
    const id = String(item?.id || '');
    if (!id || seen.has(id) || item?.is_streamable === false) continue;
    seen.add(id);
    tracks.push({
      id,
      title: item.title || 'Без названия',
      artist: item.user?.name || 'Исполнитель',
      thumbnail: item.artwork?.['480x480'] || item.artwork?.['150x150'] || '',
      duration: Number(item.duration) || 0,
    });
  }
  return tracks;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artistName = searchParams.get('artist')?.trim();

  try {
    const host = await getAudiusHost();

    if (listId) {
      const res = await fetch(`${host}/v1/playlists/${encodeURIComponent(listId)}/tracks?app_name=LiquidWave`);
      const json = await res.json();
      return NextResponse.json({ title: 'Плейлист', tracks: mapTracks(json?.data) });
    }

    if (artistName) {
      const res = await fetch(
        `${host}/v1/tracks/search?query=${encodeURIComponent(artistName)}&app_name=LiquidWave`
      );
      const json = await res.json();
      return NextResponse.json({ tracks: mapTracks(json?.data).slice(0, 20), albums: [] });
    }

    const isWave = mode === 'wave' || !rawQuery;
    const endpoint = isWave
      ? `${host}/v1/tracks/trending?app_name=LiquidWave`
      : `${host}/v1/tracks/search?query=${encodeURIComponent(rawQuery)}&app_name=LiquidWave`;

    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    let tracks = mapTracks(json?.data);

    if (isWave) {
      tracks = tracks.sort(() => Math.random() - 0.5);
    }
    tracks = tracks.slice(0, 25);

    const artistMap = new Map();
    for (const t of tracks) {
      const key = t.artist.toLowerCase();
      if (t.artist && !artistMap.has(key) && artistMap.size < 12) {
        artistMap.set(key, { id: t.artist, name: t.artist, thumbnail: t.thumbnail });
      }
    }

    let albums = [];
    if (!isWave && rawQuery) {
      try {
        const plRes = await fetch(
          `${host}/v1/playlists/search?query=${encodeURIComponent(rawQuery)}&app_name=LiquidWave`,
          { signal: AbortSignal.timeout(4000) }
        );
        const plJson = await plRes.json();
        albums = (plJson?.data || []).slice(0, 12).map((p: any) => ({
          id: String(p.id),
          title: p.playlist_name || 'Плейлист',
          artist: p.user?.name || 'Исполнитель',
          thumbnail: p.artwork?.['480x480'] || p.artwork?.['150x150'] || '',
          trackCount: p.track_count || undefined,
        }));
      } catch {}
    }

    return NextResponse.json({
      tracks,
      albums,
      artists: Array.from(artistMap.values()),
    });
  } catch (err) {
    console.error('[SEARCH] Ошибка:', err);
    return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 500 });
  }
}