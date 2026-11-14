import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface AudioSource {
  url: string;
  mimeType: string;
  userAgent: string;
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

async function getSoundCloudClientId(): Promise<string> {
  if (cachedScClientId && cachedScClientId.expiresAt > Date.now()) {
    return cachedScClientId.id;
  }
  const id = 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';
  cachedScClientId = { id, expiresAt: Date.now() + 1000 * 60 * 60 * 12 };
  return id;
}

async function searchAndGetTrackUrl(query: string, clientId: string): Promise<string | null> {
  try {
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=8`;
    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': BROWSER_UA },
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    const items: any[] = Array.isArray(data?.collection) ? data.collection : [];

    for (const track of items) {
      if (!Array.isArray(track?.media?.transcodings)) continue;
      if (track.policy === 'BLOCK' || track.policy === 'SNIP') continue;

      const progressive = track.media.transcodings.find(
        (t: any) =>
          t?.url &&
          t?.snipped !== true &&
          !t.url.includes('/preview/') &&
          t?.format?.protocol === 'progressive'
      );

      if (progressive) {
        const infoRes = await fetch(`${progressive.url}?client_id=${clientId}`, {
          signal: AbortSignal.timeout(2000),
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

async function fetchFromSoundCloud(rawId: string, targetTitle: string, targetArtist: string): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();

  // Очищаем любые ytq: префиксы и формируем чистый поисковый запрос
  let cleanId = rawId;
  if (cleanId.startsWith('ytq:')) {
    cleanId = safeDecode(cleanId.split(':').slice(2).join(':')).trim();
  }

  // Приоритет: Артист + Название
  let query = targetTitle ? `${targetArtist} ${targetTitle}`.trim() : cleanId;
  let url = await searchAndGetTrackUrl(query, clientId);

  // Если не нашлось — ищем просто по названию
  if (!url && targetTitle) {
    url = await searchAndGetTrackUrl(targetTitle, clientId);
  }

  // Последняя попытка по очищенному ID
  if (!url && cleanId !== query) {
    url = await searchAndGetTrackUrl(cleanId, clientId);
  }

  if (!url) {
    throw new Error('No playable stream on SoundCloud');
  }

  return {
    url,
    mimeType: 'audio/mpeg',
    userAgent: BROWSER_UA,
  };
}

async function handleStream(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
  isHead: boolean
) {
  try {
    const params = await context.params;
    const rawId = safeDecode(params?.id || '').trim();
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true });
    }

    const targetTitle = safeDecode((req.nextUrl.searchParams.get('t') || '').trim());
    const targetArtist = safeDecode((req.nextUrl.searchParams.get('a') || '').trim());
    const cacheKey = `${rawId}:${targetTitle}:${targetArtist}`;

    let source = streamUrlCache.get(cacheKey);
    if (!source || source.expiresAt <= Date.now()) {
      try {
        const sc = await fetchFromSoundCloud(rawId, targetTitle, targetArtist);
        source = { ...sc, expiresAt: Date.now() + 1000 * 60 * 30 };
        streamUrlCache.set(cacheKey, source);
      } catch {
        return NextResponse.json({ error: 'Track not found' }, { status: 404 });
      }
    }

    const rangeHeader = req.headers.get('range');
    const headers: Record<string, string> = { 'User-Agent': source.userAgent };
    if (rangeHeader) headers['Range'] = rangeHeader;

    const upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers,
    }).catch(() => null);

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      streamUrlCache.delete(cacheKey);
      try {
        const freshSource = await fetchFromSoundCloud(rawId, targetTitle, targetArtist);
        source = { ...freshSource, expiresAt: Date.now() + 1000 * 60 * 30 };
        streamUrlCache.set(cacheKey, source);

        const retryUpstream = await fetch(source.url, {
          method: isHead ? 'HEAD' : 'GET',
          headers,
        });
        if (!retryUpstream.ok && retryUpstream.status !== 206) {
          return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
        }
        
        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', retryUpstream.headers.get('content-type') || source.mimeType);
        responseHeaders.set('Accept-Ranges', 'bytes');
        responseHeaders.set('Cache-Control', 'private, max-age=1800');
        const cl = retryUpstream.headers.get('content-length');
        if (cl) responseHeaders.set('Content-Length', cl);
        const cr = retryUpstream.headers.get('content-range');
        if (cr) responseHeaders.set('Content-Range', cr);

        return new NextResponse(isHead ? null : retryUpstream.body, {
          status: retryUpstream.status,
          headers: responseHeaders,
        });
      } catch {
        return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
      }
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