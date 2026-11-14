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
let cachedYtVisitor: { visitorData: string; sts: number; expiresAt: number } | null = null;

const UNWANTED_MODIFIERS = [
  'remix',
  'rmx',
  'edit',
  'vip',
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
  const timer = setTimeout(() => controller.abort(), 4500);
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
        // Фильтр "Songs" в YouTube Music — возвращает только официальные студийные треки
        params: 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D',
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();

    const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    const sections =
      tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const results: { videoId: string; title: string; channel: string; durationSec: number; isYtmSong: boolean }[] = [];

    for (const sec of sections) {
      const shelfItems = sec?.musicShelfRenderer?.contents || [];
      for (const item of shelfItems) {
        const renderer = item?.musicResponsiveListItemRenderer;
        if (!renderer) continue;

        const videoId =
          renderer?.playlistItemData?.videoId ||
          renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;

        const flexCols = renderer?.flexColumns || [];
        const title =
          flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
            ?.map((r: any) => r.text)
            .join('') || '';

        const metaRuns =
          flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const metaTexts = metaRuns.map((r: any) => String(r.text || '').trim());
        const artist = metaTexts[0] || '';
        const durationText = [...metaTexts].reverse().find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t));
        const durationSec = parseDurationSec(durationText);

        results.push({
          videoId,
          title,
          channel: artist,
          durationSec,
          isYtmSong: true,
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

async function searchYoutubeTopicFallback(query: string) {
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
        query: `${query} "Topic"`,
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const sections =
      json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const results: { videoId: string; title: string; channel: string; durationSec: number; isYtmSong: boolean }[] = [];
    for (const sec of sections) {
      for (const item of sec?.itemSectionRenderer?.contents || []) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;
        const title = v.title?.runs?.map((r: any) => r.text).join('') || '';
        const channel = v.ownerText?.runs?.map((r: any) => r.text).join('') || '';
        const durationSec = parseDurationSec(v.lengthText?.simpleText);
        results.push({
          videoId: v.videoId,
          title,
          channel,
          durationSec,
          isYtmSong: channel.toLowerCase().endsWith('- topic'),
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

async function resolveYtqToOfficialVideoId(rawQuery: string, expectedDurationSec = 0): Promise<string> {
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const cacheKey = `${cleanQuery.toLowerCase()}:${expectedDurationSec}`;

  const cached = resolvedVideoIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.videoId;
  }

  const [ytmSongs, topicVideos] = await Promise.all([
    searchYoutubeMusicSongs(cleanQuery),
    searchYoutubeTopicFallback(cleanQuery),
  ]);

  const uniqueMap = new Map<
    string,
    { videoId: string; title: string; channel: string; durationSec: number; isYtmSong: boolean }
  >();
  for (const item of [...ytmSongs, ...topicVideos]) {
    if (!uniqueMap.has(item.videoId)) {
      uniqueMap.set(item.videoId, item);
    }
  }

  const queryTokens = cleanQuery
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const ranked = Array.from(uniqueMap.values())
    .map((item) => {
      let score = 0;
      if (item.isYtmSong) score += 220;
      if (hasUnwantedVariant(`${item.title} ${item.channel}`, cleanQuery)) {
        score -= 450;
      }

      if (expectedDurationSec > 0 && item.durationSec > 0) {
        const diff = Math.abs(item.durationSec - expectedDurationSec);
        if (diff <= 3) score += 250;
        else if (diff <= 7) score += 140;
        else if (diff > 15) score -= 350;
      } else if (item.durationSec > 0 && (item.durationSec < 45 || item.durationSec > 600)) {
        score -= 200;
      }

      const haystack = `${item.title} ${item.channel}`.toLowerCase();
      let matched = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) matched += 1;
      }
      if (queryTokens.length > 0) {
        score += Math.round((matched / queryTokens.length) * 120);
      }

      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const bestId = ranked[0]?.item?.videoId;
  if (!bestId) {
    throw new Error('Original studio track not found');
  }

  resolvedVideoIdCache.set(cacheKey, {
    videoId: bestId,
    expiresAt: Date.now() + 1000 * 60 * 60 * 6,
  });

  return bestId;
}

async function getYoutubeVisitorContext(videoId: string): Promise<{ visitorData: string; sts: number }> {
  if (cachedYtVisitor && cachedYtVisitor.expiresAt > Date.now()) {
    return { visitorData: cachedYtVisitor.visitorData, sts: cachedYtVisitor.sts };
  }

  try {
    const res = await fetch(`https://www.youtube.com/embed/${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(3500),
    });
    const html = await res.text();
    const visitorMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
    const stsMatch = html.match(/"sts"\s*:\s*(\d+)/);

    if (visitorMatch?.[1]) {
      cachedYtVisitor = {
        visitorData: visitorMatch[1],
        sts: stsMatch?.[1] ? Number(stsMatch[1]) : 20042,
        expiresAt: Date.now() + 1000 * 60 * 25,
      };
      return { visitorData: cachedYtVisitor.visitorData, sts: cachedYtVisitor.sts };
    }
  } catch {
    // игнорируем
  }

  return { visitorData: '', sts: 20042 };
}

async function fetchInnerTubeMp4(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  visitorData: string,
  extraClient: Record<string, any> = {},
  extraContext: Record<string, any> = {},
  sts?: number
): Promise<AudioSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const body: any = {
      videoId,
      context: {
        client: {
          clientName,
          clientVersion,
          hl: 'en',
          gl: 'US',
          ...(visitorData ? { visitorData } : {}),
          ...extraClient,
        },
        ...extraContext,
      },
      contentCheckOk: true,
      racyCheckOk: true,
    };

    if (sts) {
      body.playbackContext = {
        contentPlaybackContext: {
          signatureTimestamp: sts,
        },
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': ua,
    };
    if (visitorData) {
      headers['X-Goog-Visitor-Id'] = visitorData;
    }

    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
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

async function fetchExactYoutubeStream(videoId: string): Promise<AudioSource> {
  const { visitorData, sts } = await getYoutubeVisitorContext(videoId);

  return Promise.any([
    fetchInnerTubeMp4(
      videoId,
      'IOS',
      '19.45.4',
      'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
      visitorData,
      { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
    ),
    fetchInnerTubeMp4(
      videoId,
      'ANDROID_VR',
      '1.60.19',
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      visitorData,
      { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
    ),
    fetchInnerTubeMp4(
      videoId,
      'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      '2.0',
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 TV Safari/537.36',
      visitorData,
      {},
      { thirdParty: { embedUrl: 'https://www.youtube.com/' } },
      sts
    ),
  ]);
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
      // игнорируем
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

async function fetchVerifiedSoundCloudTrack(
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

    const validOriginals = items
      .filter((item) => {
        if (!Array.isArray(item?.media?.transcodings)) return false;
        if (item.policy === 'BLOCK' || item.policy === 'SNIP') return false;

        const durSec = (item.duration || 0) / 1000;
        if (durSec < 45 || durSec > 600) return false;

        // Строгая проверка на ремиксы, лайвы и каверы во всех полях трека
        const metaBlob = `${item.title || ''} ${item.tag_list || ''} ${item.genre || ''} ${item.user?.username || ''}`;
        if (hasUnwantedVariant(metaBlob, cleanQuery)) return false;

        // Проверяем доказательство оригинальности: официальный дистрибьютор (ISRC/publisher_metadata), галочка или точная длительность
        const hasPublisherMeta = Boolean(item.publisher_metadata?.isrc || item.publisher_metadata?.release_title);
        const isVerifiedUser = Boolean(item.user?.verified);
        const durationMatches = expectedDurationSec > 0 && Math.abs(durSec - expectedDurationSec) <= 4;

        if (!hasPublisherMeta && !isVerifiedUser && !durationMatches) {
          return false;
        }

        if (expectedDurationSec > 0 && Math.abs(durSec - expectedDurationSec) > 6) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        const aOfficial = (a.publisher_metadata?.isrc ? 2 : 0) + (a.user?.verified ? 1 : 0);
        const bOfficial = (b.publisher_metadata?.isrc ? 2 : 0) + (b.user?.verified ? 1 : 0);
        return bOfficial - aOfficial;
      });

    for (const track of validOriginals) {
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

    throw new Error('No verified original full track on SoundCloud');
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

async function getAudioSource(rawId: string, expectedDurationSec = 0): Promise<AudioSource> {
  const cacheKey = `${rawId}:${expectedDurationSec}`;
  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType, isHls: cached.isHls };
  }

  let videoId = rawId;
  let fallbackQuery = '';

  if (rawId.startsWith('ytq:')) {
    fallbackQuery = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!fallbackQuery) throw new Error('Empty track query');
    videoId = await resolveYtqToOfficialVideoId(fallbackQuery, expectedDurationSec);
  }

  let resolved: AudioSource;
  try {
    resolved = await fetchExactYoutubeStream(videoId);
  } catch {
    const q = fallbackQuery || (await fetchYoutubeTitleOEmbed(videoId));
    resolved = await fetchVerifiedSoundCloudTrack(q, expectedDurationSec);
  }

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
        ? await resolveYtqToOfficialVideoId(
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