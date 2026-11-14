// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';

const cache = new Map<string, { data: any; exp: number }>();

const WAVE_SEEDS = [
  'top hits audio',
  'инди рок хиты audio',
  'synthwave chill audio',
  'альтернативный рок хиты audio',
  'lo-fi beats audio',
  'поп хиты 2025 audio',
  'electronic dance hits audio',
];

function parseSec(text?: string): number {
  if (!text) return 0;
  const p = text.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0;
}

function extractPlaylistItems(items: any[], tracks: any[], seen: Set<string>): string | null {
  let nextToken: string | null = null;
  for (const item of items || []) {
    if (item.playlistVideoRenderer) {
      const v = item.playlistVideoRenderer;
      const id = v.videoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = v.title?.runs?.map((r: any) => r.text).join('') || v.title?.simpleText || 'Без названия';
      const artist = (v.shortBylineText?.runs?.[0]?.text || 'Исполнитель').replace(/\s*-\s*Topic$/i, '').trim();
      const duration = Number(v.lengthSeconds) || parseSec(v.lengthText?.simpleText);
      tracks.push({
        id,
        title,
        artist,
        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        duration,
      });
    } else if (item.continuationItemRenderer) {
      nextToken = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
    }
  }
  return nextToken;
}

async function fetchYoutubePlaylist(rawId: string) {
  const match = rawId.match(/[?&]list=([^&]+)/);
  const cleanId = (match ? match[1] : rawId).trim();
  const browseId = cleanId.startsWith('VL') ? cleanId : `VL${cleanId}`;

  const client = { clientName: 'WEB', clientVersion: '2.20241126.01.00', hl: 'ru', gl: 'RU' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };

  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: { client }, browseId }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();

  const title =
    json?.header?.playlistHeaderRenderer?.title?.simpleText ||
    json?.metadata?.playlistMetadataRenderer?.title ||
    'Плейлист';

  const tabs = json?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const secContents =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
      ?.playlistVideoListRenderer?.contents || [];

  const tracks: any[] = [];
  const seen = new Set<string>();
  let token = extractPlaylistItems(secContents, tracks, seen);

  let pages = 0;
  while (token && pages < 5) {
    pages += 1;
    const contRes = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { client }, continuation: token }),
      signal: AbortSignal.timeout(6000),
    });
    const contJson = await contRes.json();
    const actions = contJson?.onResponseReceivedActions || [];
    const contItems = actions[0]?.appendContinuationItemsAction?.continuationItems || [];
    token = extractPlaylistItems(contItems, tracks, seen);
  }

  return { title, tracks };
}

async function ytSearch(query: string) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20241126.01.00', hl: 'ru', gl: 'RU' } },
      query,
    }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await res.json();
  const sections =
    json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const tracks = [];
  const albums = [];
  const seen = new Set<string>();

  for (const sec of sections) {
    for (const item of sec?.itemSectionRenderer?.contents || []) {
      if (item.videoRenderer) {
        const v = item.videoRenderer;
        const duration = parseSec(v.lengthText?.simpleText);
        if (!v.videoId || seen.has(v.videoId) || (duration > 0 && (duration < 40 || duration > 900))) continue;
        seen.add(v.videoId);
        tracks.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || 'Без названия',
          artist: (v.ownerText?.runs?.[0]?.text || 'Исполнитель').replace(/\s*-\s*Topic$/i, '').trim(),
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
          duration,
        });
      } else if (item.playlistRenderer?.playlistId && !seen.has(item.playlistRenderer.playlistId)) {
        const p = item.playlistRenderer;
        seen.add(p.playlistId);
        albums.push({
          id: p.playlistId,
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

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artist = searchParams.get('artist')?.trim();

  try {
    if (listId) {
      const key = `pl:${listId}`;
      if (cache.get(key)?.exp > Date.now()) return NextResponse.json(cache.get(key)!.data);

      const pl = await fetchYoutubePlaylist(listId);
      if (pl.tracks.length > 0) {
        cache.set(key, { data: pl, exp: Date.now() + 1800000 });
      }
      return NextResponse.json(pl);
    }

    if (artist) {
      const data = await ytSearch(`${artist} topic`);
      return NextResponse.json({ tracks: data.tracks.slice(0, 20), albums: data.albums.slice(0, 12) });
    }

    const isWave = mode === 'wave' || !q;
    const query = isWave ? WAVE_SEEDS[Math.floor(Math.random() * WAVE_SEEDS.length)] : `${q} audio`;
    const key = `q:${query.toLowerCase()}`;
    if (!isWave && cache.get(key)?.exp > Date.now()) return NextResponse.json(cache.get(key)!.data);

    const { tracks, albums } = await ytSearch(query);
    const artistMap = new Map();
    for (const t of tracks) {
      const name = t.artist;
      if (name && !artistMap.has(name.toLowerCase()) && artistMap.size < 12) {
        artistMap.set(name.toLowerCase(), { id: name, name, thumbnail: t.thumbnail });
      }
    }

    const result = {
      tracks: tracks.slice(0, 25),
      albums: albums.slice(0, 16),
      artists: Array.from(artistMap.values()),
    };
    if (!isWave && tracks.length) cache.set(key, { data: result, exp: Date.now() + 1800000 });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[SEARCH] Ошибка:', err);
    return NextResponse.json({ tracks: [], albums: [], artists: [] }, { status: 500 });
  }
}