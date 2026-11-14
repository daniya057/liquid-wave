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
  'reaction',
  'tutorial',
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
  'разбор',
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
      /\((?:official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|клип|премьера|текст|аудио|видео)[^)]*\)/gi,
      ''
    )
    .replace(
      /\[(?:official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|клип|премьера|текст|аудио|видео)[^\]]*\]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseDurationSec(text?: string): number {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function scoreYoutubeCandidate(
  video: { videoId: string; title: string; channel: string; durationSec: number; snippet: string },
  cleanQuery: string
): number {
  const queryLower = cleanQuery.toLowerCase();
  const titleLower = video.title.toLowerCase();
  const channelLower = video.channel.toLowerCase();
  const snippetLower = video.snippet.toLowerCase();

  let score = 0;

  // Автогенерируемые студийные треки YouTube Music ("Artist - Topic") — точный оригинал со Spotify
  if (channelLower.endsWith('- topic') || snippetLower.includes('provided to youtube')) {
    score += 170;
  } else if (channelLower.includes('vevo') || channelLower.includes('official')) {
    score += 80;
  }

  if (titleLower.includes('official audio') || titleLower.includes('audio')) {
    score += 45;
  }

  // Жёсткий штраф за ремиксы, концерты, каверы и замедленные версии
  for (const mod of UNWANTED_MODIFIERS) {
    if (!queryLower.includes(mod)) {
      if (titleLower.includes(mod)) {
        score -= 220;
      } else if (channelLower.includes(mod) || snippetLower.includes(mod)) {
        score -= 90;
      }
    }
  }

  // Проверка адекватной длительности трека (45 сек – 10 мин)
  if (video.durationSec > 0) {
    if (video.durationSec < 45 || video.durationSec > 600) {
      score -= 150;
    } else if (video.durationSec >= 90 && video.durationSec <= 420) {
      score += 20;
    }
  }

  // Совпадение слов артиста и названия песни
  const queryTokens = queryLower
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  let matched = 0;
  const haystack = `${titleLower} ${channelLower}`;
  for (const token of queryTokens) {
    if (haystack.includes(token)) matched += 1;
  }
  if (queryTokens.length > 0) {
    score += Math.round((matched / queryTokens.length) * 100);
  }

  return score;
}

async function searchYoutubeCandidates(query: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20241126.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
        query,
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const sections =
      json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const results: { videoId: string; title: string; channel: string; durationSec: number; snippet: string }[] = [];
    for (const sec of sections) {
      for (const item of sec?.itemSectionRenderer?.contents || []) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;
        const title = v.title?.runs?.map((r: any) => r.text).join('') || '';
        const channel = v.ownerText?.runs?.map((r: any) => r.text).join('') || '';
        const durationSec = parseDurationSec(v.lengthText?.simpleText);
        const snippet =
          v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: any) => r.text).join('') || '';
        results.push({ videoId: v.videoId, title, channel, durationSec, snippet });
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveYtqToOfficialVideoId(rawQuery: string): Promise<string> {
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const cacheKey = cleanQuery.toLowerCase();

  const cached = resolvedVideoIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.videoId;
  }

  // Параллельно ищем точное совпадение и студийную topic-версию
  const [directList, topicList] = await Promise.all([
    searchYoutubeCandidates(cleanQuery),
    searchYoutubeCandidates(`${cleanQuery} topic`),
  ]);

  const uniqueMap = new Map<string, { videoId: string; title: string; channel: string; durationSec: number; snippet: string }>();
  for (const item of [...topicList, ...directList]) {
    if (!uniqueMap.has(item.videoId)) {
      uniqueMap.set(item.videoId, item);
    }
  }

  const ranked = Array.from(uniqueMap.values())
    .map((item) => ({ item, score: scoreYoutubeCandidate(item, cleanQuery) }))
    .sort((a, b) => b.score - a.score);

  const bestId = ranked[0]?.item?.videoId;
  if (!bestId) {
    throw new Error('Original studio track not found on YouTube');
  }

  resolvedVideoIdCache.set(cacheKey, {
    videoId: bestId,
    expiresAt: Date.now() + 1000 * 60 * 60 * 6,
  });

  return bestId;
}

function scoreSoundCloudCandidate(item: any, cleanQuery: string): number {
  const queryLower = cleanQuery.toLowerCase();
  const titleLower = String(item?.title || '').toLowerCase();
  const userLower = String(item?.user?.username || '').toLowerCase();
  const tagsLower = String(item?.tag_list || '').toLowerCase();
  const combined = `${titleLower} ${tagsLower}`;

  let score = 0;
  if (item?.user?.verified) score += 35;

  for (const mod of UNWANTED_MODIFIERS) {
    if (!queryLower.includes(mod)) {
      if (titleLower.includes(mod)) {
        score -= 180;
      } else if (tagsLower.includes(mod) || userLower.includes(mod)) {
        score -= 70;
      }
    }
  }

  const durationSec = (item?.duration || 0) / 1000;
  if (durationSec > 480) {
    score -= 100;
  } else if (durationSec >= 110 && durationSec <= 360) {
    score += 15;
  }

  const queryTokens = queryLower
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (combined.includes(token) || userLower.includes(token)) {
      matchedTokens += 1;
    }
  }
  if (queryTokens.length > 0) {
    score += Math.round((matchedTokens / queryTokens.length) * 60);
  }

  return score;
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

async function fetchFromSoundCloudQuery(rawQuery: string): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);

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
      .map((item) => ({ item, score: scoreSoundCloudCandidate(item, cleanQuery) }))
      .filter((entry) => entry.score > -50)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

    for (const track of rankedTracks) {
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

    for (const track of rankedTracks) {
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

    throw new Error('No original full-length stream on SoundCloud');
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
    const title = cleanTrackQuery(String(data?.title || ''));
    const author = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
    if (!title) throw new Error('Empty title');
    return author && !title.toLowerCase().includes(author.toLowerCase())
      ? `${author} - ${title}`
      : title;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInnerTubeMp4(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  extraClient: Record<string, any> = {},
  extraContext: Record<string, any> = {}
): Promise<AudioSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
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
          ...extraContext,
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

async function fetchPipedExactMp4(base: string, videoId: string): Promise<AudioSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(`${base}/streams/${videoId}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Piped HTTP ' + res.status);
    const data = await res.json();
    const streams = (data?.audioStreams || [])
      .filter((s: any) => s?.url && (s.mimeType || '').includes('mp4'))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!streams[0]?.url) throw new Error('No Piped mp4 stream');
    return {
      url: streams[0].url,
      mimeType: 'audio/mp4',
      isHls: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInvidiousExactMp4(base: string, videoId: string): Promise<AudioSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Invidious HTTP ' + res.status);
    const data = await res.json();
    const formats = (data?.adaptiveFormats || [])
      .filter((f: any) => f?.url && typeof f.type === 'string' && f.type.includes('audio/mp4'))
      .sort((a: any, b: any) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    if (!formats[0]?.url) throw new Error('No Invidious mp4 stream');
    return {
      url: formats[0].url,
      mimeType: 'audio/mp4',
      isHls: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExactYoutubeStream(videoId: string): Promise<AudioSource> {
  return Promise.any([
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
    ),
    fetchInnerTubeMp4(
      videoId,
      'WEB_EMBEDDED_PLAYER',
      '1.20241126.01.00',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      {},
      { thirdParty: { embedUrl: 'https://www.youtube.com/' } }
    ),
    ...PIPED_INSTANCES.map((base) => fetchPipedExactMp4(base, videoId)),
    ...INVIDIOUS_INSTANCES.map((base) => fetchInvidiousExactMp4(base, videoId)),
  ]);
}

async function getAudioSource(rawId: string): Promise<AudioSource> {
  const cached = streamUrlCache.get(rawId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType, isHls: cached.isHls };
  }

  let videoId = rawId;
  let fallbackQuery = '';

  if (rawId.startsWith('ytq:')) {
    fallbackQuery = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!fallbackQuery) throw new Error('Empty track query');
    videoId = await resolveYtqToOfficialVideoId(fallbackQuery);
  }

  // Сначала забираем точный оригинальный поток YouTube (даём ему 4.5 сек приоритета)
  const ytPromise = fetchExactYoutubeStream(videoId);
  const scPromise = (async () => {
    const q = fallbackQuery || (await fetchYoutubeTitleOEmbed(videoId));
    return fetchFromSoundCloudQuery(q);
  })();

  const exactYoutubeResult = await Promise.race([
    ytPromise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 4500)),
  ]);

  const resolved = exactYoutubeResult || (await Promise.any([ytPromise, scPromise]));

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