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
  // Быстрый дефолтный client_id SoundCloud (работает мгновенно без парсинга главной страницы)
  const id = 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';
  cachedScClientId = { id, expiresAt: Date.now() + 1000 * 60 * 60 * 12 };
  return id;
}

async function fetchFromSoundCloud(query: string): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=5`;
  
  const res = await fetch(searchUrl, {
    signal: AbortSignal.timeout(3000),
    headers: { 'User-Agent': BROWSER_UA },
  });
  
  if (!res.ok) throw new Error('SC search failed');
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
        signal: AbortSignal.timeout(2500),
      }).catch(() => null);
      
      if (infoRes && infoRes.ok) {
        const info = await infoRes.json();
        if (info?.url && !info.url.includes('/preview/')) {
          return {
            url: info.url,
            mimeType: 'audio/mpeg',
            userAgent: BROWSER_UA,
          };
        }
      }
    }
  }

  throw new Error('No stream found');
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

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true });
    }

    const targetTitle = safeDecode((req.nextUrl.searchParams.get('t') || '').trim());
    const targetArtist = safeDecode((req.nextUrl.searchParams.get('a') || '').trim());
    
    // Формируем поисковый запрос
    let query = targetTitle ? `${targetArtist} ${targetTitle}`.trim() : rawId;
    if (rawId.startsWith('ytq:')) {
      query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    }

    const cacheKey = query.toLowerCase();
    let source = streamUrlCache.get(cacheKey);

    if (!source || source.expiresAt <= Date.now()) {
      try {
        const sc = await fetchFromSoundCloud(query);
        source = { ...sc, expiresAt: Date.now() + 1000 * 60 * 30 };
        streamUrlCache.set(cacheKey, source);
      } catch {
        // Если с артистом не нашлось, ищем просто по названию трека
        try {
          const sc = await fetchFromSoundCloud(targetTitle || rawId);
          source = { ...sc, expiresAt: Date.now() + 1000 * 60 * 30 };
          streamUrlCache.set(cacheKey, source);
        } catch {
          return NextResponse.json({ error: 'Track not found' }, { status: 404 });
        }
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