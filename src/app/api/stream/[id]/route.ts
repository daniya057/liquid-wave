import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const streamUrlCache = new Map<string, { url: string; mimeType: string; expiresAt: number }>();

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.artemislena.eu',
];

async function resolveYtqId(rawId: string): Promise<string> {
  if (!rawId.startsWith('ytq:')) return rawId;
  const query = decodeURIComponent(rawId.split(':').slice(2).join(':'));
  const res = await fetch(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    }
  );
  const html = await res.text();
  const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!match?.[1]) throw new Error('Track not found');
  return match[1];
}

async function fetchInnerTubeOne(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  extraClient: Record<string, any> = {}
): Promise<{ url: string; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
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

    const audioFormats = formats
      .filter((f: any) => f.url && typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/'))
      .sort((a: any, b: any) => {
        const aMp4 = a.mimeType.includes('mp4') ? 1 : 0;
        const bMp4 = b.mimeType.includes('mp4') ? 1 : 0;
        if (aMp4 !== bMp4) return bMp4 - aMp4;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });

    if (!audioFormats[0]?.url) throw new Error('No audio format');
    return {
      url: audioFormats[0].url,
      mimeType: audioFormats[0].mimeType.split(';')[0] || 'audio/mp4',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPipedOne(base: string, videoId: string): Promise<{ url: string; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`${base}/streams/${videoId}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Piped HTTP ' + res.status);
    const data = await res.json();
    const streams = (data?.audioStreams || []).sort((a: any, b: any) => {
      const aM4a = (a.mimeType || '').includes('mp4') ? 1 : 0;
      const bM4a = (b.mimeType || '').includes('mp4') ? 1 : 0;
      if (aM4a !== bM4a) return bM4a - aM4a;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });
    if (!streams[0]?.url) throw new Error('No Piped stream');
    return {
      url: streams[0].url,
      mimeType: streams[0].mimeType?.split(';')[0] || 'audio/mp4',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInvidiousOne(base: string, videoId: string): Promise<{ url: string; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Invidious HTTP ' + res.status);
    const data = await res.json();
    const formats = (data?.adaptiveFormats || [])
      .filter((f: any) => f.url && typeof f.type === 'string' && f.type.startsWith('audio/'))
      .sort((a: any, b: any) => {
        const aM4a = a.type.includes('mp4') ? 1 : 0;
        const bM4a = b.type.includes('mp4') ? 1 : 0;
        if (aM4a !== bM4a) return bM4a - aM4a;
        return Number(b.bitrate || 0) - Number(a.bitrate || 0);
      });
    if (!formats[0]?.url) throw new Error('No Invidious stream');
    return {
      url: formats[0].url,
      mimeType: formats[0].type.split(';')[0] || 'audio/mp4',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getAudioSource(videoId: string): Promise<{ url: string; mimeType: string }> {
  const cached = streamUrlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType };
  }

  const resolved = await Promise.any([
    fetchInnerTubeOne(
      videoId,
      'ANDROID_VR',
      '1.60.19',
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
    ),
    fetchInnerTubeOne(
      videoId,
      'IOS',
      '19.45.4',
      'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
      { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
    ),
    ...PIPED_INSTANCES.map((base) => fetchPipedOne(base, videoId)),
    ...INVIDIOUS_INSTANCES.map((base) => fetchInvidiousOne(base, videoId)),
  ]);

  streamUrlCache.set(videoId, {
    url: resolved.url,
    mimeType: resolved.mimeType,
    expiresAt: Date.now() + 1000 * 60 * 90,
  });

  return resolved;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rawId = decodeURIComponent(id || '');
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    const videoId = await resolveYtqId(rawId);
    const source = await getAudioSource(videoId);

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true, id: videoId });
    }

    const rangeHeader = req.headers.get('range');
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    };
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    let upstream = await fetch(source.url, { headers: upstreamHeaders });

    if (upstream.status === 403 || upstream.status === 410) {
      streamUrlCache.delete(videoId);
      const fresh = await getAudioSource(videoId);
      upstream = await fetch(fresh.url, { headers: upstreamHeaders });
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

    return new NextResponse(upstream.body, {
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