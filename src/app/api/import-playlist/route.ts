// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import yts from 'yt-search';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { Track } from '@/lib/instances';

const execFileAsync = promisify(execFile);

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findBestYouTubeMatch(title: string, artist: string): Promise<Track | null> {
  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const primaryArtist = artist.split(',')[0]?.trim() || artist;

  const queries = [`${primaryArtist} - ${title}`.trim(), `${title} ${primaryArtist}`.trim()];
  if (cleanTitle && cleanTitle !== title) {
    queries.push(`${primaryArtist} - ${cleanTitle}`.trim());
  }

  for (const q of queries) {
    try {
      const res = await yts(q);
      const best = (res.videos || []).find(
        (v) => v.videoId && v.seconds >= 25 && v.seconds <= 1500
      );
      if (best) {
        return {
          id: best.videoId,
          title: title || best.title,
          artist: artist || best.author?.name || 'Исполнитель',
          thumbnail: best.thumbnail || `https://i.ytimg.com/vi/${best.videoId}/mqdefault.jpg`,
          duration: best.seconds || 0,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveTracksByQueries(
  items: { title: string; artist: string }[]
): Promise<Track[]> {
  const tracks: Track[] = [];
  const limited = items.slice(0, 1000);

  for (let i = 0; i < limited.length; i += 12) {
    const batch = limited.slice(i, i + 12);
    const resolved = await Promise.all(
      batch.map((item) => findBestYouTubeMatch(item.title, item.artist))
    );
    for (const tr of resolved) {
      if (tr) tracks.push(tr);
    }
    if (i + 12 < limited.length) await sleep(80);
  }

  return tracks;
}

async function findSpotifyPathfinderQuery(
  pageHtml: string
): Promise<{ opName: string; hash: string } | null> {
  const scriptUrls = [
    ...pageHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https:\/\/[^"]*spotifycdn\.com\/[^"]+\.js)"/g),
  ].map((m) => m[1]);

  const uniqueUrls = Array.from(new Set(scriptUrls));
  const queryRegex = /"(fetchPlaylist(?:Contents)?)"\s*,\s*"query"\s*,\s*"([a-f0-9]{64})"/;

  for (const jsUrl of uniqueUrls) {
    try {
      const jsRes = await fetch(jsUrl, { headers: BROWSER_HEADERS });
      if (!jsRes.ok) continue;
      const jsText = await jsRes.text();

      const directMatch = jsText.match(queryRegex);
      if (directMatch) return { opName: directMatch[1], hash: directMatch[2] };

      const chunkIdMatch = jsText.match(/"(\d+)"\s*:\s*"xpui-routes-playlist"/);
      if (chunkIdMatch) {
        const chunkId = chunkIdMatch[1];
        const hashMatches = [
          ...jsText.matchAll(new RegExp(`"${chunkId}"\\s*:\\s*"([a-f0-9]{8,20})"`, 'g')),
        ];
        const baseDir = jsUrl.substring(0, jsUrl.lastIndexOf('/') + 1);

        for (const hm of hashMatches) {
          const chunkUrl = `${baseDir}xpui-routes-playlist.${hm[1]}.js`;
          const chunkRes = await fetch(chunkUrl, { headers: BROWSER_HEADERS });
          if (!chunkRes.ok) continue;
          const chunkText = await chunkRes.text();
          const chunkQueryMatch = chunkText.match(queryRegex);
          if (chunkQueryMatch) {
            return { opName: chunkQueryMatch[1], hash: chunkQueryMatch[2] };
          }
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function importFromSpotify(url: string): Promise<{ name: string; tracks: Track[] }> {
  const match = url.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Неверная ссылка Spotify');

  const [, kind, spotifyId] = match;
  const [pageRes, embedRes] = await Promise.all([
    fetch(`https://open.spotify.com/${kind}/${spotifyId}`, { headers: BROWSER_HEADERS }),
    fetch(`https://open.spotify.com/embed/${kind}/${spotifyId}`, { headers: BROWSER_HEADERS }),
  ]);

  const pageHtml = pageRes.ok ? await pageRes.text() : '';
  const embedHtml = embedRes.ok ? await embedRes.text() : '';

  let embedNextData: any = null;
  const nextDataMatch = embedHtml.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (nextDataMatch) {
    try {
      embedNextData = JSON.parse(nextDataMatch[1]);
    } catch {}
  }

  const entity = embedNextData?.props?.pageProps?.state?.data?.entity;
  const ogTitle = pageHtml.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  const name = entity?.name || ogTitle || 'Плейлист Spotify';

  let accessToken: string | null = null;
  let clientId: string | null = null;

  const sessionMatch = pageHtml.match(
    /<script id="session" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (sessionMatch) {
    try {
      const sessionJson = JSON.parse(sessionMatch[1]);
      accessToken = sessionJson?.accessToken || null;
      clientId = sessionJson?.clientId || null;
    } catch {}
  }

  accessToken =
    accessToken ||
    pageHtml.match(/"accessToken"\s*:\s*"([^"]+)"/)?.[1] ||
    embedNextData?.props?.pageProps?.state?.settings?.session?.accessToken ||
    null;

  clientId =
    clientId ||
    pageHtml.match(/"clientId"\s*:\s*"([^"]+)"/)?.[1] ||
    embedNextData?.props?.pageProps?.state?.settings?.session?.clientId ||
    null;

  let clientToken: string | null = null;
  if (clientId) {
    try {
      const ctRes = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': BROWSER_HEADERS['User-Agent'],
        },
        body: JSON.stringify({
          client_data: {
            client_version: '1.2.52.442.g08c99610',
            client_id: clientId,
            js_sdk_data: {
              device_brand: 'unknown',
              device_model: 'unknown',
              os: 'windows',
              os_version: 'NT 10.0',
              device_id: crypto.randomUUID(),
              device_type: 'computer',
            },
          },
        }),
      });
      if (ctRes.ok) {
        const ctData = await ctRes.json();
        clientToken = ctData?.granted_token?.token || null;
      }
    } catch {}
  }

  let queries: { title: string; artist: string }[] = [];

  if (accessToken && kind === 'playlist') {
    const pfQuery = await findSpotifyPathfinderQuery(pageHtml);
    if (pfQuery) {
      const pfHeaders: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'app-platform': 'WebPlayer',
        'spotify-app-version': '1.2.52.442.g08c99610',
        Origin: 'https://open.spotify.com',
        Referer: 'https://open.spotify.com/',
        'User-Agent': BROWSER_HEADERS['User-Agent'],
      };
      if (clientToken) pfHeaders['client-token'] = clientToken;

      let offset = 0;
      const limit = 100;

      while (offset < 1000) {
        const variables: Record<string, any> = {
          uri: `spotify:playlist:${spotifyId}`,
          offset,
          limit,
        };
        if (pfQuery.opName === 'fetchPlaylist') {
          variables.enableWatchFeedEntrypoint = false;
        }

        const pfRes = await fetch('https://api-partner.spotify.com/pathfinder/v1/query', {
          method: 'POST',
          headers: pfHeaders,
          body: JSON.stringify({
            variables,
            operationName: pfQuery.opName,
            extensions: { persistedQuery: { version: 1, sha256Hash: pfQuery.hash } },
          }),
        });

        if (!pfRes.ok) {
          console.error(`Spotify Pathfinder offset=${offset} статус ${pfRes.status}`);
          break;
        }

        const pfData = await pfRes.json();
        const content = pfData?.data?.playlistV2?.content;
        const items = Array.isArray(content?.items) ? content.items : [];
        if (items.length === 0) break;

        for (const entry of items) {
          const trackData = entry?.itemV2?.data;
          if (!trackData?.name) continue;
          const artistItems = trackData?.artists?.items;
          const artistNames = Array.isArray(artistItems)
            ? artistItems.map((a: any) => a?.profile?.name).filter(Boolean).join(', ')
            : '';
          queries.push({ title: String(trackData.name), artist: artistNames });
        }

        const totalCount = content?.totalCount ?? 0;
        offset += limit;
        if (items.length < limit || (totalCount > 0 && offset >= totalCount)) break;
      }
    }
  }

  if (queries.length === 0) {
    const rawList = Array.isArray(entity?.trackList) ? entity.trackList : [];
    queries = rawList
      .filter((t: any) => t?.title)
      .map((t: any) => ({ title: String(t.title), artist: String(t.subtitle || '') }));
  }

  if (queries.length === 0) {
    throw new Error('Плейлист Spotify пуст или закрыт настройками приватности');
  }

  console.log(`Найдено треков в Spotify "${name}": ${queries.length}`);
  const tracks = await resolveTracksByQueries(queries);
  return { name, tracks };
}

async function importFromYouTube(listId: string): Promise<{ name: string; tracks: Track[] }> {
  const playlist = await yts({ listId });
  const seen = new Set<string>();
  const tracks: Track[] = [];

  for (const v of playlist.videos || []) {
    const id = v.videoId;
    const sec = v.seconds ?? v.duration?.seconds ?? 0;
    if (!id || seen.has(id) || (sec > 0 && (sec < 25 || sec > 1500))) continue;
    seen.add(id);
    tracks.push({
      id,
      title: v.title || 'Без названия',
      artist: v.author?.name || 'Исполнитель',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      duration: sec,
    });
  }

  return { name: playlist.title || 'Плейлист YouTube', tracks };
}

async function importViaYtDlp(url: string): Promise<{ name: string; tracks: Track[] }> {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);

  const { stdout } = await execFileAsync(
    ytDlpPath,
    ['--flat-playlist', '-J', '--no-warnings', url],
    { timeout: 30000, maxBuffer: 15 * 1024 * 1024 }
  );

  const data = JSON.parse(stdout);
  const name = data.title || 'Импортированный плейлист';
  const entries = Array.isArray(data.entries) ? data.entries : [];

  const queries = entries
    .filter((e: any) => e?.title)
    .map((e: any) => ({ title: String(e.title), artist: String(e.uploader || e.artist || '') }));

  const tracks = await resolveTracksByQueries(queries);
  return { name, tracks };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = String(body?.url || '').trim();

    if (!url) {
      return NextResponse.json({ error: 'Вставь ссылку на плейлист' }, { status: 400 });
    }

    if (url.includes('spotify.com')) {
      const result = await importFromSpotify(url);
      if (result.tracks.length === 0) {
        return NextResponse.json({ error: 'Не удалось найти треки из этого плейлиста' }, { status: 404 });
      }
      return NextResponse.json(result);
    }

    try {
      const parsedUrl = new URL(url);
      const listId = parsedUrl.searchParams.get('list');
      if (listId) {
        const result = await importFromYouTube(listId);
        if (result.tracks.length > 0) return NextResponse.json(result);
      }
    } catch {}

    const fallbackResult = await importViaYtDlp(url);
    if (fallbackResult.tracks.length === 0) {
      return NextResponse.json(
        { error: 'Не удалось распознать треки по этой ссылке. Убедись, что плейлист публичный.' },
        { status: 404 }
      );
    }

    return NextResponse.json(fallbackResult);
  } catch (err: any) {
    console.error('Ошибка импорта плейлиста:', err);
    return NextResponse.json(
      { error: err?.message || 'Ошибка при импорте плейлиста' },
      { status: 500 }
    );
  }
}