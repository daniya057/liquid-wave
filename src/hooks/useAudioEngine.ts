import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AudioSource {
  url: string;
  mimeType: string;
  isHls?: boolean;
}

const streamUrlCache = new Map<string, AudioSource & { expiresAt: number }>();
const resolvedVideoIdCache = new Map<string, { videoId: string; expiresAt: number }>();
let cachedScClientId: { id: string; expiresAt: number } | null = null;

const UNWANTED_MODIFIERS = [
  'remix',
  'rmx',
  'flip',
  'bootleg',
  'mashup',
  'rework',
  'live',
  'concert',
  'tour',
  'festival',
  'session',
  'acoustic',
  'unplugged',
  'slowed',
  'reverb',
  'sped up',
  'speed up',
  'nightcore',
  '8d',
  'bass boosted',
  'bassboost',
  'cover',
  'karaoke',
  'instrumental',
  'tribute',
  'parody',
  'snippet',
  'teaser',
  'ремикс',
  'концерт',
  'лайв',
  'акустик',
  'замедл',
  'ускор',
  'кавер',
  'минус',
  'инструментал',
  'пародия',
];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanTrackQuery(raw: string): string {
  return raw
    .replace(
      /\((?:official\vert{}music\vert{}lyric\vert{}lyrics\vert{}audio\vert{}video\vert{}visualizer\vert{}hd\vert{}hq\vert{}4k\vert{}8k\vert{}explicit\vert{}clean\vert{}клип\vert{}премьера\vert{}текст\vert{}аудио\vert{}видео)[^)]*\)/gi,
      ''
    )
    .replace(
      /\[(?:official\vert{}music\vert{}lyric\vert{}lyrics\vert{}audio\vert{}video\vert{}visualizer\vert{}hd\vert{}hq\vert{}4k\vert{}8k\vert{}explicit\vert{}clean\vert{}клип\vert{}премьера\vert{}текст\vert{}аудио\vert{}видео)[^\]]*\]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseDurationSec(text?: string): number {
  if (!text) return 0;
  const parts = text.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function hasUnwantedVariant(text: string, allowedQuery: string): boolean {
  const qLower = allowedQuery.toLowerCase();
  const tLower = text.toLowerCase();
  return UNWANTED_MODIFIERS.some((mod) => !qLower.includes(mod) && tLower.includes(mod));
}

async function searchYoutubeMusicSongs(query: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com/',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20241127.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
        query,
        params: 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D',
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();

    const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const results: { videoId: string; title: string; channel: string; durationSec: number }[] = [];

    for (const sec of sections) {
      for (const item of sec?.musicShelfRenderer?.contents || []) {
        const renderer = item?.musicResponsiveListItemRenderer;
        if (!renderer) continue;

        const videoId =
          renderer?.playlistItemData?.videoId ||
          renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
            ?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;

        const flexCols = renderer?.flexColumns || [];
        const title =
          flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
            ?.map((r: any) => r.text)
            .join('') || '';
        const metaRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const metaTexts = metaRuns.map((r: any) => String(r.text || '').trim());
        const artist = metaTexts[0] || '';
        const durationText = [...metaTexts].reverse().find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t));

        results.push({
          videoId,
          title,
          channel: artist,
          durationSec: parseDurationSec(durationText),
        });
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveYtqToVideoId(rawQuery: string, expectedDurationSec = 0): Promise<string | null> {
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const cacheKey = `${cleanQuery.toLowerCase()}:${expectedDurationSec}`;

  const cached = resolvedVideoIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.videoId;
  }

  const songs = await searchYoutubeMusicSongs(cleanQuery);
  if (!songs.length) return null;

  const ranked = songs
    .map((item) => {
      let score = 100;
      if (hasUnwantedVariant(`${item.title} ${item.channel}`, cleanQuery)) score -= 300;
      if (expectedDurationSec > 0 && item.durationSec > 0) {
        const diff = Math.abs(item.durationSec - expectedDurationSec);
        if (diff <= 4) score += 200;
        else if (diff <= 8) score += 100;
        else if (diff > 15) score -= 250;
      }
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const bestId = ranked[0]?.item?.videoId || null;
  if (bestId) {
    resolvedVideoIdCache.set(cacheKey, {
      videoId: bestId,
      expiresAt: Date.now() + 1000 * 60 * 60 * 6,
    });
  }
  return bestId;
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

async function fetchFromSoundCloudQuery(
  rawQuery: string,
  expectedDurationSec = 0
): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(cleanQuery)}&client_id=${clientId}&limit=15`;
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

    const rankedTracks = items
      .filter(
        (item) =>
          Array.isArray(item?.media?.transcodings) &&
          (item.duration || 0) >= 45000 &&
          item.policy !== 'BLOCK'
      )
      .map((item) => {
        let score = 0;
        const durSec = (item.duration || 0) / 1000;
        const metaBlob = `${item.title || ''} ${item.tag_list || ''} ${item.user?.username || ''}`;

        if (hasUnwantedVariant(metaBlob, cleanQuery)) score -= 250;
        if (item.publisher_metadata?.isrc || item.publisher_metadata?.release_title) score += 120;
        if (item.user?.verified) score += 60;

        if (expectedDurationSec > 0) {
          const diff = Math.abs(durSec - expectedDurationSec);
          if (diff <= 4) score += 180;
          else if (diff <= 8) score += 90;
          else if (diff > 15) score -= 200;
        } else if (durSec > 480) {
          score -= 100;
        }

        return { item, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

    for (const track of rankedTracks) {
      const progressive = track.media.transcodings.find(
        (t: any) => isFullTranscoding(t) && t?.format?.protocol === 'progressive'
      );
      if (progressive) {
        const infoRes = await fetch(`${progressive.url}?client_id=${clientId}`, { signal: controller.signal });
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info?.url && !info.url.includes('/preview/')) {
            return { url: info.url, mimeType: 'audio/mpeg', isHls: false };
          }
        }
      }

      const hls = track.media.transcodings.find(
        (t: any) => isFullTranscoding(t) && t?.format?.protocol === 'hls'
      );
      if (hls) {
        const infoRes = await fetch(`${hls.url}?client_id=${clientId}`, { signal: controller.signal });
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info?.url && !info.url.includes('/preview/')) {
            return { url: info.url, mimeType: 'application/vnd.apple.mpegurl', isHls: true };
          }
        }
      }
    }

    throw new Error('No full-length stream on SoundCloud');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYoutubeTitleOEmbed(videoId: string): Promise<string> {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    { signal: AbortSignal.timeout(3500) }
  );
  if (!res.ok) throw new Error('oEmbed failed');
  const data = await res.json();
  const title = cleanTrackQuery(String(data?.title || ''));
  const author = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
  if (!title) throw new Error('Empty title');
  return author && !title.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${title}` : title;
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

async function getAudioSource(rawId: string, expectedDurationSec = 0): Promise<AudioSource> {
  const cacheKey = `${rawId}:${expectedDurationSec}`;
  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType, isHls: cached.isHls };
  }

  let videoId: string | null = rawId;
  let query = '';

  if (rawId.startsWith('ytq:')) {
    query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!query) throw new Error('Empty track query');
    videoId = await resolveYtqToVideoId(query, expectedDurationSec);
  }

  const tasks: Promise<AudioSource>[] = [];

  if (videoId) {
    tasks.push(
      fetchInnerTubeMp4(
        videoId,
        'IOS',
        '19.45.4',
        'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
        { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
      ),
      fetchInnerTubeMp4(
        videoId,
        'ANDROID_VR',
        '1.60.19',
        'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
      )
    );
  }

  tasks.push(
    (async () => {
      const q = query || (videoId ? await fetchYoutubeTitleOEmbed(videoId) : '');
      if (!q) throw new Error('No query for SoundCloud');
      return fetchFromSoundCloudQuery(q, expectedDurationSec);
    })()
  );

  const resolved = await Promise.any(tasks);

  streamUrlCache.set(cacheKey, {
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

  if (isAppleSafari) {
    return new NextResponse(isHead ? null : m3u8Text, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  }

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

    const expectedDurationSec = Number(req.nextUrl.searchParams.get('d') || '0') || 0;

    if (req.nextUrl.searchParams.get('resolve') === '1') {
      const videoId = rawId.startsWith('ytq:')
        ? await resolveYtqToVideoId(
            safeDecode(rawId.split(':').slice(2).join(':')).trim(),
            expectedDurationSec
          )
        : rawId;
      return NextResponse.json({ videoId });
    }

    const source = await getAudioSource(rawId, expectedDurationSec);

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
      streamUrlCache.delete(`${rawId}:${expectedDurationSec}`);
      const fresh = await getAudioSource(rawId, expectedDurationSec);
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