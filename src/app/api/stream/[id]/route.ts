import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AudioSource {
  url: string;
  mimeType: string;
  isHls?: boolean;
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

  const pageRes = await fetch('https://soundcloud.com', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  const html = await pageRes.text();
  const scriptUrls = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .slice(-6);

  for (const scriptUrl of scriptUrls.reverse()) {
    try {
      const jsRes = await fetch(scriptUrl);
      const js = await jsRes.text();
      const match =
        js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) ||
        js.match(/client_id=([a-zA-Z0-9]{32})/);
      if (match?.[1]) {
        cachedScClientId = {
          id: match[1],
          expiresAt: Date.now() + 1000 * 60 * 60 * 12,
        };
        return match[1];
      }
    } catch {
      // проверяем следующий скрипт
    }
  }

  throw new Error('SoundCloud client_id not found');
}

function isFullTranscoding(t: any): boolean {
  if (!t?.url || typeof t.url !== 'string') return false;
  if (t.snipped === true) return false;
  if (t.url.includes('/preview/')) return false;
  return true;
}

async function fetchFromSoundCloudQuery(query: string): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);

  try {
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=10`;
    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error('SC search HTTP ' + res.status);

    const data = await res.json();
    const items: any[] = Array.isArray(data?.collection) ? data.collection : [];

    // Берём только полноценные треки длиннее 45 секунд
    const fullTracks = items.filter(
      (item) =>
        Array.isArray(item?.media?.transcodings) &&
        (item.duration || 0) >= 45000 &&
        item.policy !== 'BLOCK'
    );

    // 1. Сначала ищем прямой полный progressive MP3 (без /preview/)
    for (const track of fullTracks) {
      const progressive = track.media.transcodings.find(
        (t: any) => isFullTranscoding(t) && t?.format?.protocol === 'progressive'
      );
      if (!progressive) continue;

      const streamInfoRes = await fetch(`${progressive.url}?client_id=${clientId}`, {
        signal: controller.signal,
      });
      if (!streamInfoRes.ok) continue;

      const streamInfo = await streamInfoRes.json();
      if (streamInfo?.url && !streamInfo.url.includes('/preview/')) {
        return {
          url: streamInfo.url,
          mimeType: 'audio/mpeg',
          isHls: false,
        };
      }
    }

    // 2. Если прямого MP3 нет — берём полный HLS-поток (на iPhone играет нативно без лимита 30 сек)
    for (const track of fullTracks) {
      const hls = track.media.transcodings.find(
        (t: any) => isFullTranscoding(t) && t?.format?.protocol === 'hls'
      );
      if (!hls) continue;

      const streamInfoRes = await fetch(`${hls.url}?client_id=${clientId}`, {
        signal: controller.signal,
      });
      if (!streamInfoRes.ok) continue;

      const streamInfo = await streamInfoRes.json();
      if (streamInfo?.url && !streamInfo.url.includes('/preview/')) {
        return {
          url: streamInfo.url,
          mimeType: 'application/vnd.apple.mpegurl',
          isHls: true,
        };
      }
    }

    throw new Error('No full-length stream on SoundCloud');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYoutubeTitleOEmbed(videoId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error('oEmbed failed');
    const data = await res.json();
    const title = String(data?.title || '').trim();
    const author = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
    if (!title) throw new Error('Empty title');
    return author && !title.toLowerCase().includes(author.toLowerCase())
      ? `${author} ${title}`
      : title;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromSoundCloudByVideoId(videoId: string): Promise<AudioSource> {
  const title = await fetchYoutubeTitleOEmbed(videoId);
  return fetchFromSoundCloudQuery(title);
}

async function fetchInnerTubeMp4(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  extraClient: Record<string, any> = {}
): Promise<AudioSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ua,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName,
            clientVersion,
            hl: 'en',
            gl: 'US',
            ...extraClient,
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) throw new Error('InnerTube HTTP ' + res.status);
    const data = await res.json();
    const formats = [
      ...(data?.streamingData?.adaptiveFormats || []),
      ...(data?.streamingData?.formats || []),
    ];

    const mp4Audio = formats
      .filter(
        (f: any) =>
          f.url &&
          typeof f.mimeType === 'string' &&
          f.mimeType.toLowerCase().includes('audio/mp4')
      )
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!mp4Audio[0]?.url) throw new Error('No audio/mp4 format');
    return {
      url: mp4Audio[0].url,
      mimeType: 'audio/mp4',
      isHls: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getAudioSource(rawId: string): Promise<AudioSource> {
  const cached = streamUrlCache.get(rawId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType, isHls: cached.isHls };
  }

  let resolved: AudioSource;

  if (rawId.startsWith('ytq:')) {
    const query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!query) throw new Error('Empty track query');
    resolved = await fetchFromSoundCloudQuery(query);
  } else {
    resolved = await Promise.any([
      fetchFromSoundCloudByVideoId(rawId),
      fetchInnerTubeMp4(
        rawId,
        'IOS',
        '19.45.4',
        'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
        { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
      ),
      fetchInnerTubeMp4(
        rawId,
        'ANDROID_VR',
        '1.60.19',
        'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
      ),
    ]);
  }

  streamUrlCache.set(rawId, {
    url: resolved.url,
    mimeType: resolved.mimeType,
    isHls: resolved.isHls,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });

  return resolved;
}

async function handleHlsStream(req: NextRequest, m3u8Url: string, isHead: boolean) {
  const m3u8Res = await fetch(m3u8Url);
  if (!m3u8Res.ok) {
    return NextResponse.json({ error: 'Failed to load HLS playlist' }, { status: 502 });
  }

  const m3u8Text = await m3u8Res.text();
  const ua = req.headers.get('user-agent') || '';
  const isAppleSafari = /iPhone|iPad|iPod|Macintosh/i.test(ua) && !/Chrome|CriOS|Edg/i.test(ua);

  // iPhone / Safari декодирует .m3u8 нативно в <audio> с перемоткой и фоном
  if (isAppleSafari) {
    return new NextResponse(isHead ? null : m3u8Text, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Для Chrome / Windows склеиваем сегменты в непрерывный MP3-поток
  const segmentUrls = m3u8Text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http'));

  if (segmentUrls.length === 0) {
    return NextResponse.json({ error: 'Empty HLS segments' }, { status: 502 });
  }

  if (isHead) {
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const segUrl of segmentUrls) {
          if (req.signal.aborted) break;
          const segRes = await fetch(segUrl, { signal: req.signal });
          if (!segRes.ok || !segRes.body) continue;
          const reader = segRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
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

    const source = await getAudioSource(rawId);

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true });
    }

    if (source.isHls) {
      return handleHlsStream(req, source.url, isHead);
    }

    const rangeHeader = req.headers.get('range');
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    };
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    let upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
    });

    if (upstream.status === 403 || upstream.status === 410) {
      streamUrlCache.delete(rawId);
      const fresh = await getAudioSource(rawId);
      if (fresh.isHls) {
        return handleHlsStream(req, fresh.url, isHead);
      }
      upstream = await fetch(fresh.url, {
        method: isHead ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || source.mimeType);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'no-store');

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