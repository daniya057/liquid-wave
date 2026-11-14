import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SC_CLIENT_ID = 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';

interface AudioSource {
  url: string;
  mimeType: string;
}

const cache = new Map<string, { source: AudioSource; exp: number }>();

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function getSoundCloudStreamUrl(query: string): Promise<string | null> {
  try {
    let cleanQuery = query;
    if (cleanQuery.startsWith('ytq:')) {
      cleanQuery = safeDecode(cleanQuery.split(':').slice(2).join(':'));
    }
    cleanQuery = cleanQuery.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();

    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(cleanQuery)}&client_id=${SC_CLIENT_ID}&limit=10`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const items = Array.isArray(data?.collection) ? data.collection : [];

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
        const infoRes = await fetch(`${progressive.url}?client_id=${SC_CLIENT_ID}`, {
          headers: { 'User-Agent': BROWSER_UA },
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
  } catch (e) {
    console.error('SC Stream Error:', e);
  }
  return null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const rawId = safeDecode(id || '').trim();
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true });
    }

    const targetTitle = safeDecode(req.nextUrl.searchParams.get('t') || '');
    const targetArtist = safeDecode(req.nextUrl.searchParams.get('a') || '');

    const cacheKey = `${rawId}:${targetTitle}:${targetArtist}`;
    let cached = cache.get(cacheKey);

    if (!cached || cached.exp <= Date.now()) {
      let audioUrl = await getSoundCloudStreamUrl(targetTitle ? `${targetArtist} ${targetTitle}` : rawId);

      if (!audioUrl && targetTitle) {
        audioUrl = await getSoundCloudStreamUrl(targetTitle);
      }

      if (!audioUrl) {
        audioUrl = await getSoundCloudStreamUrl(rawId);
      }

      if (!audioUrl) {
        return NextResponse.json({ error: 'Track stream not found' }, { status: 404 });
      }

      cached = {
        source: { url: audioUrl, mimeType: 'audio/mpeg' },
        exp: Date.now() + 1000 * 60 * 30,
      };
      cache.set(cacheKey, cached);
    }

    const range = req.headers.get('range');
    const upstreamHeaders: Record<string, string> = { 'User-Agent': BROWSER_UA };
    if (range) upstreamHeaders['Range'] = range;

    const upstream = await fetch(cached.source.url, {
      headers: upstreamHeaders,
    }).catch(() => null);

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      cache.delete(cacheKey);
      return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || cached.source.mimeType);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'private, max-age=1800');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return GET(req, context);
}