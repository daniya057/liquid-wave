// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function toLazyTracks(items: { title: string; artist: string; thumbnail?: string }[]) {
  return items.map((item, idx) => {
    const q = `${item.artist} ${item.title}`.trim();
    return {
      id: `ytq:${idx}:${encodeURIComponent(q)}`,
      title: item.title || 'Без названия',
      artist: item.artist || 'Исполнитель',
      thumbnail: item.thumbnail || '',
      duration: 0,
    };
  });
}

async function findSpotifyQuery(pageHtml: string) {
  const urls = Array.from(
    new Set([...pageHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https:\/\/[^"]*spotifycdn\.com\/[^"]+\.js)"/g)].map((m) => m[1]))
  );
  const re = /"(fetchPlaylist(?:Contents)?)"\s*,\s*"query"\s*,\s*"([a-f0-9]{64})"/;

  for (const url of urls) {
    try {
      const txt = await (await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(4000) })).text();
      const m = txt.match(re);
      if (m) return { opName: m[1], hash: m[2] };

      const chunkId = txt.match(/"(\d+)"\s*:\s*"xpui-routes-playlist"/)?.[1];
      if (chunkId) {
        const hashes = [...txt.matchAll(new RegExp(`"${chunkId}"\\s*:\\s*"([a-f0-9]{8,20})"`, 'g'))];
        const base = url.substring(0, url.lastIndexOf('/') + 1);
        for (const h of hashes) {
          const cTxt = await (await fetch(`${base}xpui-routes-playlist.${h[1]}.js`, { headers: HEADERS, signal: AbortSignal.timeout(4000) })).text();
          const cm = cTxt.match(re);
          if (cm) return { opName: cm[1], hash: cm[2] };
        }
      }
    } catch {}
  }
  return null;
}

async function importFromSpotify(url: string) {
  const match = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Неверная ссылка Spotify');

  const [, kind, spotifyId] = match;
  const [pageRes, embedRes] = await Promise.all([
    fetch(`https://open.spotify.com/${kind}/${spotifyId}`, { headers: HEADERS, signal: AbortSignal.timeout(6000) }),
    fetch(`https://open.spotify.com/embed/${kind}/${spotifyId}`, { headers: HEADERS, signal: AbortSignal.timeout(6000) }),
  ]);

  const pageHtml = pageRes.ok ? await pageRes.text() : '';
  const embedHtml = embedRes.ok ? await embedRes.text() : '';

  let embedData: any = null;
  const nd = embedHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nd) try { embedData = JSON.parse(nd[1]); } catch {}

  const entity = embedData?.props?.pageProps?.state?.data?.entity;
  const name = entity?.name || pageHtml.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || 'Плейлист Spotify';

  let accessToken = pageHtml.match(/"accessToken"\s*:\s*"([^"]+)"/)?.[1] || embedData?.props?.pageProps?.state?.settings?.session?.accessToken || null;
  let clientId = pageHtml.match(/"clientId"\s*:\s*"([^"]+)"/)?.[1] || embedData?.props?.pageProps?.state?.settings?.session?.clientId || null;

  const sm = pageHtml.match(/<script id="session" type="application\/json">([\s\S]*?)<\/script>/);
  if (sm) {
    try {
      const sj = JSON.parse(sm[1]);
      accessToken = sj?.accessToken || accessToken;
      clientId = sj?.clientId || clientId;
    } catch {}
  }

  let clientToken: string | null = null;
  if (clientId) {
    try {
      const ctRes = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': HEADERS['User-Agent'] },
        body: JSON.stringify({
          client_data: {
            client_version: '1.2.52.442.g08c99610',
            client_id: clientId,
            js_sdk_data: { device_brand: 'unknown', device_model: 'unknown', os: 'windows', os_version: 'NT 10.0', device_id: crypto.randomUUID(), device_type: 'computer' },
          },
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (ctRes.ok) clientToken = (await ctRes.json())?.granted_token?.token || null;
    } catch {}
  }

  const itemsList: { title: string; artist: string; thumbnail?: string }[] = [];

  if (accessToken && kind === 'playlist') {
    const pfQuery = await findSpotifyQuery(pageHtml);
    if (pfQuery) {
      const pfHeaders: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'app-platform': 'WebPlayer',
        'spotify-app-version': '1.2.52.442.g08c99610',
        Origin: 'https://open.spotify.com',
        Referer: 'https://open.spotify.com/',
        'User-Agent': HEADERS['User-Agent'],
      };
      if (clientToken) pfHeaders['client-token'] = clientToken;

      let offset = 0;
      while (offset < 1000) {
        const variables: any = { uri: `spotify:playlist:${spotifyId}`, offset, limit: 100 };
        if (pfQuery.opName === 'fetchPlaylist') variables.enableWatchFeedEntrypoint = false;

        const pfRes = await fetch('https://api-partner.spotify.com/pathfinder/v1/query', {
          method: 'POST',
          headers: pfHeaders,
          body: JSON.stringify({ variables, operationName: pfQuery.opName, extensions: { persistedQuery: { version: 1, sha256Hash: pfQuery.hash } } }),
          signal: AbortSignal.timeout(6000),
        });
        if (!pfRes.ok) break;

        const content = (await pfRes.json())?.data?.playlistV2?.content;
        const items = Array.isArray(content?.items) ? content.items : [];
        if (!items.length) break;

        for (const entry of items) {
          const td = entry?.itemV2?.data;
          if (!td?.name) continue;
          const artists = (td?.artists?.items || []).map((a: any) => a?.profile?.name).filter(Boolean).join(', ');
          const thumb = td?.albumOfTrack?.coverArt?.sources?.[0]?.url || '';
          itemsList.push({ title: String(td.name), artist: artists, thumbnail: thumb });
        }

        offset += 100;
        if (items.length < 100 || (content?.totalCount > 0 && offset >= content.totalCount)) break;
      }
    }
  }

  if (!itemsList.length) {
    for (const t of entity?.trackList || []) {
      if (t?.title) itemsList.push({ title: String(t.title), artist: String(t.subtitle || '') });
    }
  }

  if (!itemsList.length) throw new Error('Плейлист Spotify пуст или закрыт');
  console.log(`Мгновенно импортировано из Spotify "${name}": ${itemsList.length}`);
  return { name, tracks: toLazyTracks(itemsList) };
}

async function importFromYouTube(listId: string) {
  const browseId = listId.startsWith('VL') ? listId : `VL${listId}`;
  const client = { clientName: 'WEB', clientVersion: '2.20241126.01.00', hl: 'ru', gl: 'RU' };
  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ context: { client }, browseId }),
    signal: AbortSignal.timeout(6000),
  });
  const json = await res.json();
  const name = json?.header?.playlistHeaderRenderer?.title?.simpleText || 'Плейлист YouTube';
  const raw = json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

  const tracks: any[] = [];
  for (const item of raw) {
    const v = item.playlistVideoRenderer;
    if (!v?.videoId) continue;
    tracks.push({
      id: v.videoId,
      title: v.title?.runs?.map((r: any) => r.text).join('') || 'Без названия',
      artist: (v.shortBylineText?.runs?.[0]?.text || 'Исполнитель').replace(/\s*-\s*Topic$/i, '').trim(),
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      duration: Number(v.lengthSeconds) || 0,
    });
  }
  return { name, tracks };
}

export async function POST(request: NextRequest) {
  try {
    const { url: rawUrl } = await request.json();
    const url = String(rawUrl || '').trim();
    if (!url) return NextResponse.json({ error: 'Вставь ссылку на плейлист' }, { status: 400 });

    if (url.includes('spotify.com')) {
      return NextResponse.json(await importFromSpotify(url));
    }

    const listId = new URL(url).searchParams.get('list');
    if (listId) {
      return NextResponse.json(await importFromYouTube(listId));
    }

    return NextResponse.json({ error: 'Поддерживаются ссылки Spotify и YouTube' }, { status: 400 });
  } catch (err: any) {
    console.error('Ошибка импорта:', err);
    return NextResponse.json({ error: err?.message || 'Ошибка импорта' }, { status: 500 });
  }
}