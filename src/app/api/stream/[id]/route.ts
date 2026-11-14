import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface AudioSource {
  url: string;
  mimeType: string;
  userAgent: string;
  provider: 'soundcloud';
}

const streamUrlCache = new Map<string, AudioSource & { expiresAt: number }>();
let cachedScClientId: { id: string; expiresAt: number } | null = null;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanTrackQuery(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function getSoundCloudClientId(): Promise<string> {
  if (cachedScClientId && cachedScClientId.expiresAt > Date.now()) {
    return cachedScClientId.id;
  }

  try {
    const pageRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(4000),
    });
    const html = await pageRes.text();
    const scriptUrls = [
      ...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
    ]
      .map((m) => m[1])
      .reverse()
      .slice(0, 10);

    for (const scriptUrl of scriptUrls) {
      try {
        const jsRes = await fetch(scriptUrl, { signal: AbortSignal.timeout(3000) });
        if (!jsRes.ok) continue;
        const js = await jsRes.text();
        const match =
          js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) ||
          js.match(/client_id=([a-zA-Z0-9]{32})/);
        if (match?.[1]) {
          const id = match[1];
          cachedScClientId = { id, expiresAt: Date.now() + 1000 * 60 * 60 * 12 };
          return id;
        }
      } catch {}
    }
  } catch {}

  return 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';
}

async function searchAndGetTrackUrl(query: string, clientId: string): Promise<string | null> {
  try {
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=12`;
    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(4500),
      headers: { 'User-Agent': BROWSER_UA },
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    const items: any[] = Array.isArray(data?.collection) ? data.collection : [];

    for (const track of items) {
      if (!Array.isArray(track?.media?.transcodings)) continue;
      if (track.policy === 'BLOCK' || track.policy === 'SNIP') continue;
      if ((track.duration || 0) < 25000) continue;

      const progressive = track.media.transcodings.find(
        (t: any) =>
          t?.url &&
          t?.snipped !== true &&
          !t.url.includes('/preview/') &&
          t?.format?.protocol === 'progressive'
      );

      if (progressive) {
        const infoRes = await fetch(`${progressive.url}?client_id=${clientId}`, {
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        if (infoRes && infoRes.ok) {
          const info = await infoRes.json();
          if (info?.url && !info.url.includes('/preview/')) {
            return info.url;
          }
        }
      }
    }
  } catch {}
  return null;
}

async function fetchFromSoundCloud(rawQuery: string, targetTitle: string, targetArtist: string): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();

  // 1. Пробуем полный запрос
  let url = await searchAndGetTrackUrl(rawQuery, clientId);

  // 2. Если не нашлось, пробуем "Артист + Название" (без лишних скобок)
  if (!url && (targetTitle || targetArtist)) {
    const cleanQ = `${targetArtist} ${cleanTrackQuery(targetTitle)}`.trim();
    if (cleanQ && cleanQ !== rawQuery) {
      url = await searchAndGetTrackUrl(cleanQ, clientId);
    }
  }

  // 3. Если всё еще нет, ищем просто чистое название трека
  if (!url && targetTitle) {
    url = await searchAndGetTrackUrl(cleanTrackQuery(targetTitle), clientId);
  }

  // 4. Крайний случай — ищем по сырому ID / запросу
  if (!url) {
    url = await searchAndGetTrackUrl(rawQuery, clientId);
  }

  if (!url) {
    throw new Error('No playable stream on SoundCloud');
  }

  return {
    url,
    mimeType: 'audio/mpeg',
    userAgent: BROWSER_UA,
    provider: 'soundcloud',
  };
}

async function handleStream(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  isHead: boolean
) {
  try {
    const { id } = await params;
    const rawId = safeDecode(id || '').trim();
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    const isPrefetch = req.nextUrl.searchParams.get('prefetch') === '1';
    const targetTitle = safeDecode((req.nextUrl.searchParams.get('t') || '').trim());
    const targetArtist = safeDecode((req.nextUrl.searchParams.get('a') || '').trim());
    const cacheKey = `${rawId}:${targetTitle}:${targetArtist}`;

    let source = streamUrlCache.get(cacheKey);
    if (!source || source.expiresAt <= Date.now()) {
      let query = targetTitle
        ? targetArtist
          ? `${targetArtist} ${targetTitle}`
          : targetTitle
        : '';

      if (rawId.startsWith('ytq:')) {
        query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
      } else if (!query) {
        query = rawId;
      }

      try {
        const sc = await fetchFromSoundCloud(query, targetTitle, targetArtist);
        source = { ...sc, expiresAt: Date.now() + 1000 * 60 * 60 };
        streamUrlCache.set(cacheKey, source);
      } catch (err) {
        if (isPrefetch) return NextResponse.json({ ok: false });
        return NextResponse.json({ error: 'Track not found' }, { status: 404 });
      }
    }

    if (isPrefetch) {
      return NextResponse.json({ ok: true });
    }

    const rangeHeader = req.headers.get('range');
    const headers: Record<string, string> = { 'User-Agent': source.userAgent };
    if (rangeHeader) headers['Range'] = rangeHeader;

    let upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers,
    }).catch(() => null);

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      streamUrlCache.delete(cacheKey);
      let query = targetTitle ? `${targetArtist} ${targetTitle}` : rawId;
      if (rawId.startsWith('ytq:')) query = safeDecode(rawId.split(':').slice(2).join(':')).trim();

      try {
        const freshSource = await fetchFromSoundCloud(query, targetTitle, targetArtist);
        source = { ...freshSource, expiresAt: Date.now() + 1000 * 60 * 60 };
        streamUrlCache.set(cacheKey, source);

        upstream = await fetch(source.url, {
          method: isHead ? 'HEAD' : 'GET',
          headers,
        });
      } catch {
        return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
      }
    }

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || source.mimeType);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'private, max-age=1800');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    return new NextResponse(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to stream audio' },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleStream(req, context, false);
}

export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleStream(req, context, true);
}