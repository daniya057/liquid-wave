import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
};

interface ImportedItem {
  title: string;
  artist: string;
  thumbnail?: string;
  durationSec?: number;
  videoId?: string;
}

function makeStableTrackId(title: string, artist: string): string {
  const normalized = `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  const q = `${artist} ${title}`.trim();
  return `ytq:${hash}:${encodeURIComponent(q)}`;
}

function toLazyTracks(items: ImportedItem[]) {
  const seen = new Set<string>();
  const result: {
    id: string;
    title: string;
    artist: string;
    thumbnail: string;
    duration: number;
  }[] = [];

  for (const item of items) {
    const title = (item.title || '').trim();
    const artist = (item.artist || '').trim();
    if (!title) continue;

    const id = item.videoId ? item.videoId : makeStableTrackId(title, artist);
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      title,
      artist: artist || 'Исполнитель',
      thumbnail: item.thumbnail || '',
      duration: item.durationSec && item.durationSec > 0 ? Math.round(item.durationSec) : 0,
    });
  }

  return result;
}

async function resolveRedirects(rawUrl: string): Promise<string> {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.hostname.includes('spotify.link') ||
      parsed.hostname.includes('spoti.fi') ||
      parsed.hostname.includes('on.soundcloud.com')
    ) {
      const res = await fetch(rawUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (res.url) return res.url;
    }
  } catch {}
  return rawUrl;
}

async function getSpotifyOfficialToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.access_token || null;
  } catch {
    return null;
  }
}

async function importFromSpotifyOfficialApi(
  kind: 'playlist' | 'album',
  spotifyId: string,
  token: string
): Promise<{ name: string; tracks: ReturnType<typeof toLazyTracks> } | null> {
  try {
    const metaRes = await fetch(`https://api.spotify.com/v1/${kind}s/${spotifyId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const name = String(meta?.name || (kind === 'album' ? 'Альбом Spotify' : 'Плейлист Spotify'));
    const fallbackCover = meta?.images?.[0]?.url || '';
    const items: ImportedItem[] = [];

    if (kind === 'album') {
      const albumTracks = Array.isArray(meta?.tracks?.items) ? meta.tracks.items : [];
      for (const t of albumTracks) {
        if (!t?.name) continue;
        const artists = (t.artists || [])
          .map((a: any) => a?.name)
          .filter(Boolean)
          .join(', ');
        items.push({
          title: String(t.name),
          artist: artists,
          thumbnail: fallbackCover,
          durationSec: Math.round(Number(t.duration_ms || 0) / 1000),
        });
      }
    } else {
      let nextUrl: string | null =
        `https://api.spotify.com/v1/playlists/${spotifyId}/tracks?limit=100`;
      let pageGuard = 0;
      while (nextUrl && pageGuard < 10) {
        pageGuard++;
        const pageRes = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!pageRes.ok) break;
        const pageData = await pageRes.json();
        for (const entry of pageData?.items || []) {
          const t = entry?.track;
          if (!t?.name || t.is_local) continue;
          const artists = (t.artists || [])
            .map((a: any) => a?.name)
            .filter(Boolean)
            .join(', ');
          const thumb = t?.album?.images?.[0]?.url || fallbackCover;
          items.push({
            title: String(t.name),
            artist: artists,
            thumbnail: thumb,
            durationSec: Math.round(Number(t.duration_ms || 0) / 1000),
          });
        }
        nextUrl = pageData?.next || null;
      }
    }

    if (items.length === 0) return null;
    return { name, tracks: toLazyTracks(items) };
  } catch {
    return null;
  }
}

async function importFromSpotify(url: string) {
  const match = url.match(
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album)\/([a-zA-Z0-9]+)/i
  );
  if (!match) throw new Error('Неверная ссылка Spotify. Нужна ссылка на плейлист или альбом.');

  const kind = match[1].toLowerCase() as 'playlist' | 'album';
  const spotifyId = match[2];

  // 1. Официальный Spotify Web API (если заданы SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)
  const officialToken = await getSpotifyOfficialToken();
  if (officialToken) {
    const apiResult = await importFromSpotifyOfficialApi(kind, spotifyId, officialToken);
    if (apiResult && apiResult.tracks.length > 0) {
      return apiResult;
    }
  }

  // 2. Публичные метаданные embed-страницы Spotify (работает без ключей)
  const [embedRes, oembedRes] = await Promise.all([
    fetch(`https://open.spotify.com/embed/${kind}/${spotifyId}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(6000),
    }),
    fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${kind}/${spotifyId}`)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(4000) }
    ).catch(() => null),
  ]);

  const embedHtml = embedRes.ok ? await embedRes.text() : '';
  const oembedJson = oembedRes && oembedRes.ok ? await oembedRes.json().catch(() => null) : null;

  let embedData: any = null;
  const nd = embedHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      embedData = JSON.parse(nd[1]);
    } catch {}
  }

  if (!embedData) {
    const initMatch = embedHtml.match(/<script id="initial-state" type="text\/plain">([\s\S]*?)<\/script>/);
    if (initMatch) {
      try {
        const decoded = Buffer.from(initMatch[1].trim(), 'base64').toString('utf8');
        embedData = JSON.parse(decoded);
      } catch {}
    }
  }

  const entity =
    embedData?.props?.pageProps?.state?.data?.entity ||
    embedData?.data?.entity ||
    null;

  const coverUrl =
    entity?.coverArt?.sources?.[0]?.url ||
    oembedJson?.thumbnail_url ||
    '';

  const name =
    entity?.name ||
    oembedJson?.title ||
    (kind === 'album' ? 'Альбом Spotify' : 'Плейлист Spotify');

  const albumMainArtist =
    kind === 'album' && Array.isArray(entity?.artists)
      ? entity.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
      : '';

  const itemsList: ImportedItem[] = [];
  const rawTrackList = Array.isArray(entity?.trackList) ? entity.trackList : [];

  for (const t of rawTrackList) {
    if (!t?.title) continue;
    const rawSubtitle = String(t.subtitle || '').replace(/\u00a0/g, ' ').trim();
    const artist = rawSubtitle || albumMainArtist;
    const durMs = Number(t.duration || 0);
    itemsList.push({
      title: String(t.title).trim(),
      artist,
      thumbnail: coverUrl,
      durationSec: durMs > 0 ? Math.round(durMs / 1000) : 0,
    });
  }

  if (!itemsList.length) {
    throw new Error(
      'Не удалось получить треки из Spotify. Убедись, что плейлист публичный (не приватный и не «Для вас»).'
    );
  }

  return { name, tracks: toLazyTracks(itemsList) };
}

function splitYoutubeTitleAndArtist(rawTitle: string, channelName: string): {
  title: string;
  artist: string;
} {
  const cleanChannel = channelName.replace(/\s*-\s*Topic$/i, '').trim();
  const isTopicChannel = /\s*-\s*Topic$/i.test(channelName);

  // Убираем типичные видео-хвосты в конце названия
  const cleanedTitle = rawTitle
    .replace(
      /\s*[\(\[](?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|lyrics|visualizer|клип|премьера\s*клипа|официальный\s*клип|audio|hd|4k)[\)\]]\s*/gi,
      ' '
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (isTopicChannel && cleanChannel) {
    return { title: cleanedTitle, artist: cleanChannel };
  }

  // Если видео называется "Артист - Название трека", разделяем их правильно
  const dashMatch = cleanedTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    const leftArtist = dashMatch[1].trim();
    const rightTitle = dashMatch[2].trim();
    if (leftArtist.length >= 2 && rightTitle.length >= 1) {
      return { title: rightTitle, artist: leftArtist };
    }
  }

  return { title: cleanedTitle, artist: cleanChannel || 'Исполнитель' };
}

async function importFromYouTube(listId: string) {
  if (listId.startsWith('RD')) {
    throw new Error('Автоматические миксы YouTube (RD...) не поддерживаются. Нужен обычный плейлист или альбом.');
  }

  const browseId = listId.startsWith('VL') ? listId : `VL${listId}`;
  const client = { clientName: 'WEB', clientVersion: '2.20241126.01.00', hl: 'ru', gl: 'RU' };
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': HEADERS['User-Agent'] },
    body: JSON.stringify({ context: { client }, browseId }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    throw new Error('Не удалось загрузить плейлист YouTube');
  }

  const json = await res.json();
  const name =
    json?.header?.playlistHeaderRenderer?.title?.simpleText ||
    json?.header?.pageHeaderRenderer?.pageTitle ||
    'Плейлист YouTube';

  const raw =
    json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
      ?.playlistVideoListRenderer?.contents || [];

  const items: ImportedItem[] = [];
  for (const item of raw) {
    const v = item.playlistVideoRenderer;
    if (!v?.videoId) continue;

    const rawTitle = v.title?.runs?.map((r: any) => r.text).join('') || '';
    const rawChannel = v.shortBylineText?.runs?.[0]?.text || '';
    if (!rawTitle || rawTitle === '[Deleted video]' || rawTitle === '[Private video]') continue;

    const parsed = splitYoutubeTitleAndArtist(rawTitle, rawChannel);

    items.push({
      videoId: v.videoId,
      title: parsed.title,
      artist: parsed.artist,
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      durationSec: Number(v.lengthSeconds) || 0,
    });
  }

  if (!items.length) {
    throw new Error('Плейлист YouTube пуст или закрыт настройками приватности');
  }

  return { name, tracks: toLazyTracks(items) };
}

async function getSoundCloudClientId(): Promise<string> {
  try {
    const pageRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      signal: AbortSignal.timeout(3500),
    });
    const html = await pageRes.text();
    const scriptUrls = [
      ...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
    ]
      .map((m) => m[1])
      .reverse()
      .slice(0, 10);

    for (let i = 0; i < scriptUrls.length; i += 5) {
      const batch = scriptUrls.slice(i, i + 5);
      const foundList = await Promise.all(
        batch.map(async (u) => {
          try {
            const js = await (await fetch(u, { signal: AbortSignal.timeout(2500) })).text();
            const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
            return m?.[1] || null;
          } catch {
            return null;
          }
        })
      );
      const id = foundList.find(Boolean);
      if (id) return id;
    }
  } catch {}
  return 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';
}

async function importFromSoundCloud(url: string) {
  const clientId = await getSoundCloudClientId();
  const cleanUrl = url.split('?')[0];
  const resolveRes = await fetch(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(cleanUrl)}&client_id=${clientId}`,
    {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!resolveRes.ok) {
    throw new Error('Не удалось загрузить плейлист SoundCloud. Проверь, что он публичный.');
  }

  const data = await resolveRes.json();
  if (data?.kind !== 'playlist' || !Array.isArray(data?.tracks)) {
    throw new Error('Указанная ссылка SoundCloud не является плейлистом или альбомом.');
  }

  const name = String(data.title || 'Плейлист SoundCloud');
  const rawTracks: any[] = data.tracks;

  // SoundCloud отдаёт полные метаданные для первых 5 треков, а для остальных — только id; догружаем их пачкой
  const missingIds = rawTracks.filter((t) => !t?.title && t?.id).map((t) => t.id);
  const hydratedMap = new Map<number, any>();

  for (let i = 0; i < missingIds.length; i += 50) {
    const chunk = missingIds.slice(i, i + 50);
    const bulkRes = await fetch(
      `https://api-v2.soundcloud.com/tracks?ids=${chunk.join(',')}&client_id=${clientId}`,
      {
        headers: { 'User-Agent': HEADERS['User-Agent'] },
        signal: AbortSignal.timeout(5000),
      }
    ).catch(() => null);
    if (bulkRes?.ok) {
      const list = await bulkRes.json();
      if (Array.isArray(list)) {
        for (const tr of list) {
          if (tr?.id) hydratedMap.set(tr.id, tr);
        }
      }
    }
  }

  const items: ImportedItem[] = [];
  for (const raw of rawTracks) {
    const t = raw?.title ? raw : hydratedMap.get(raw?.id);
    if (!t?.title) continue;

    const artist = String(t.publisher_metadata?.artist || t.user?.username || 'Исполнитель').trim();
    const rawThumb = String(t.artwork_url || t.user?.avatar_url || '');
    const thumb = rawThumb ? rawThumb.replace('-large.', '-t500x500.') : '';

    items.push({
      title: String(t.title).trim(),
      artist,
      thumbnail: thumb,
      durationSec: Math.round(Number(t.duration || 0) / 1000),
    });
  }

  if (!items.length) {
    throw new Error('Плейлист SoundCloud пуст');
  }

  return { name, tracks: toLazyTracks(items) };
}

export async function POST(request: NextRequest) {
  try {
    const { url: rawUrl } = await request.json();
    const inputUrl = String(rawUrl || '').trim();
    if (!inputUrl) {
      return NextResponse.json({ error: 'Вставь ссылку на плейлист' }, { status: 400 });
    }

    const url = await resolveRedirects(inputUrl);

    if (url.includes('spotify.com')) {
      return NextResponse.json(await importFromSpotify(url));
    }

    if (url.includes('soundcloud.com')) {
      return NextResponse.json(await importFromSoundCloud(url));
    }

    let listId: string | null = null;
    try {
      listId = new URL(url).searchParams.get('list');
    } catch {}

    if (listId) {
      return NextResponse.json(await importFromYouTube(listId));
    }

    return NextResponse.json(
      { error: 'Поддерживаются ссылки на плейлисты и альбомы Spotify, YouTube, YouTube Music и SoundCloud' },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Ошибка импорта плейлиста' },
      { status: 500 }
    );
  }
}