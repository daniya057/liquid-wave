import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.drgns.space',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
  'https://invidious.private.coffee',
];

interface AudioSource {
  url: string;
  mimeType: string;
  userAgent: string;
  provider: 'youtube' | 'soundcloud';
  isHls?: boolean;
}

interface CachedBuffer {
  bytes: Uint8Array;
  contentType: string;
  expiresAt: number;
}

const streamUrlCache = new Map<string, AudioSource & { expiresAt: number }>();
const fullAudioBufferCache = new Map<string, CachedBuffer>();
const ytmLookupCache = new Map<
  string,
  { videoId: string; durationSec: number; title: string; artist: string; expiresAt: number }
>();
const durationLookupCache = new Map<string, { durationSec: number; expiresAt: number }>();
let cachedScClientId: { id: string; expiresAt: number } | null = null;

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
  'type beat',
  'beat',
  'mix',
  'megamix',
  'full album',
  'album',
  'compilation',
  'podcast',
  'radio show',
  '1 hour',
  '2 hours',
  'loop',
  'extended',
  'ringtone',
  'reaction',
  'review',
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
  'бит',
  'микс',
  'мегамикс',
  'полный альбом',
  'альбом',
  'сборник',
  'подкаст',
  'рингтон',
];

const STOP_WORDS = new Set([
  'feat',
  'ft',
  'with',
  'prod',
  'official',
  'audio',
  'video',
  'lyrics',
  'lyric',
  'music',
  'the',
  'and',
  'topic',
  'explicit',
  'clean',
  'remastered',
  'remaster',
  'hd',
  'hq',
  '4k',
  'vevo',
]);

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function transliterate(str: string): string {
  return str
    .toLowerCase()
    .split('')
    .map((ch) => (CYRILLIC_TO_LATIN[ch] !== undefined ? CYRILLIC_TO_LATIN[ch] : ch))
    .join('')
    .replace(/x/g, 'ks')
    .replace(/ph/g, 'f')
    .replace(/iy\b/g, 'y')
    .replace(/ii\b/g, 'i');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripFeaturingAndTags(raw: string): string {
  return raw
    .replace(/\((?:feat\.?|ft\.?|with|prod\.?)\s+[^)]+\)/gi, '')
    .replace(/\[(?:feat\.?|ft\.?|with|prod\.?)\s+[^\]]+\]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/i, '')
    .replace(
      /\((?:official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^)]*\)/gi,
      ''
    )
    .replace(
      /\[(?:official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^\]]*\]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
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

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return matches.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function buildTokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const tok of tokenize(text)) {
    set.add(tok);
    const tr = transliterate(tok);
    if (tr.length > 1) set.add(tr);
  }
  return set;
}

function tokensMatch(token: string, candSet: Set<string>): boolean {
  if (candSet.has(token)) return true;
  const tr = transliterate(token);
  if (tr.length > 1 && candSet.has(tr)) return true;
  return false;
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
  return UNWANTED_MODIFIERS.some((mod) => {
    if (qLower.includes(mod)) return false;
    const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u');
    return regex.test(tLower);
  });
}

function setBufferCache(key: string, entry: CachedBuffer) {
  if (fullAudioBufferCache.size >= 8) {
    const oldestKey = fullAudioBufferCache.keys().next().value;
    if (oldestKey) fullAudioBufferCache.delete(oldestKey);
  }
  fullAudioBufferCache.set(key, entry);
}

/**
 * Узнаёт эталонную длительность песни (в секундах) через lrclib.net или iTunes Search API.
 */
async function lookupReferenceDurationSec(title: string, artist: string): Promise<number> {
  const cleanT = stripFeaturingAndTags(title);
  const primaryA = artist.split(/[,&]|feat\.?|ft\.?/i)[0].trim();
  const key = `${primaryA.toLowerCase()}|${cleanT.toLowerCase()}`;
  if (!cleanT) return 0;

  const cached = durationLookupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.durationSec;
  }

  try {
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanT)}&artist_name=${encodeURIComponent(primaryA)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        const hit = list.find(
          (item: any) => Number(item?.duration) >= 75 && Number(item?.duration) <= 600
        );
        if (hit?.duration) {
          const sec = Math.round(Number(hit.duration));
          durationLookupCache.set(key, {
            durationSec: sec,
            expiresAt: Date.now() + 1000 * 60 * 60 * 24,
          });
          return sec;
        }
      }
    }
  } catch {}

  try {
    const term = `${primaryA} ${cleanT}`.trim();
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`,
      { signal: AbortSignal.timeout(2500) }
    );
    if (res.ok) {
      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const hit = results.find(
        (r: any) => Number(r?.trackTimeMillis) >= 75000 && Number(r?.trackTimeMillis) <= 600000
      );
      if (hit?.trackTimeMillis) {
        const sec = Math.round(Number(hit.trackTimeMillis) / 1000);
        durationLookupCache.set(key, {
          durationSec: sec,
          expiresAt: Date.now() + 1000 * 60 * 60 * 24,
        });
        return sec;
      }
    }
  } catch {}

  return 0;
}

function scoreCandidateMatch(params: {
  candidateTitle: string;
  candidateArtist: string;
  candidateDurationSec: number;
  targetTitle: string;
  targetArtist: string;
  fallbackQuery: string;
  expectedDurationSec: number;
  strictArtist?: boolean;
}): number {
  const {
    candidateTitle,
    candidateArtist,
    candidateDurationSec,
    targetTitle,
    targetArtist,
    fallbackQuery,
    expectedDurationSec,
    strictArtist = true,
  } = params;

  const allowedContext = `${targetArtist} ${targetTitle} ${fallbackQuery}`.trim();
  const candCombined = `${candidateArtist} ${candidateTitle}`.toLowerCase();

  if (hasUnwantedVariant(candCombined, allowedContext)) {
    return -10000;
  }

  const allowsShort = /(?:^|\s)(?:intro|outro|skit|interlude|интро|аутро|скит|интерлюдия)(?:\s|$)/i.test(
    allowedContext
  );
  const allowsLong = /(?:^|\s)(?:mix|set|album|podcast|live|symphony|микс|сет|альбом|подкаст)(?:\s|$)/i.test(
    allowedContext
  );

  if (candidateDurationSec > 0) {
    if (
      !allowsShort &&
      candidateDurationSec < 85 &&
      (expectedDurationSec === 0 || expectedDurationSec >= 90)
    ) {
      return -10000;
    }
    if (
      !allowsLong &&
      candidateDurationSec > 600 &&
      (expectedDurationSec === 0 || expectedDurationSec <= 580)
    ) {
      return -10000;
    }
    if (expectedDurationSec > 0) {
      const diff = Math.abs(candidateDurationSec - expectedDurationSec);
      if (diff > 15) {
        return -10000;
      }
    }
  }

  const candAllTokens = buildTokenSet(candCombined);
  const candTitleTokens = buildTokenSet(stripFeaturingAndTags(candidateTitle));

  const coreTitle = stripFeaturingAndTags(targetTitle) || targetTitle || fallbackQuery;
  const titleTokens = tokenize(coreTitle);
  if (titleTokens.length === 0) return -10000;

  let matchedTitleCount = 0;
  for (const tok of titleTokens) {
    if (tokensMatch(tok, candTitleTokens) || tokensMatch(tok, candAllTokens)) {
      matchedTitleCount++;
    }
  }

  const titleRatio = matchedTitleCount / titleTokens.length;
  if (matchedTitleCount === 0 || titleRatio < 0.75) {
    return -10000;
  }

  let score = Math.round(titleRatio * 240);

  if (targetArtist) {
    const primaryArtist = targetArtist.split(/[,&]|feat\.?|ft\.?/i)[0].trim() || targetArtist;
    const artistTokens = tokenize(primaryArtist);
    if (artistTokens.length > 0) {
      let matchedArtistCount = 0;
      for (const tok of artistTokens) {
        if (tokensMatch(tok, candAllTokens)) matchedArtistCount++;
      }
      const artistRatio = matchedArtistCount / artistTokens.length;
      if (artistRatio >= 0.5) {
        score += Math.round(artistRatio * 220);
      } else if (strictArtist) {
        return -10000;
      } else {
        const exactDurationMatch =
          expectedDurationSec > 0 &&
          candidateDurationSec > 0 &&
          Math.abs(candidateDurationSec - expectedDurationSec) <= 3;
        if (!exactDurationMatch || titleRatio < 1.0) {
          return -10000;
        }
        score -= 60;
      }
    }
  }

  if (expectedDurationSec > 0 && candidateDurationSec > 0) {
    const diff = Math.abs(candidateDurationSec - expectedDurationSec);
    if (diff <= 3) score += 260;
    else if (diff <= 6) score += 170;
    else if (diff <= 10) score += 60;
    else score -= 120;
  }

  return score;
}

/**
 * Поиск точного студийного трека в каталоге YouTube Music (работает даже с Render).
 */
async function searchYoutubeMusicSong(
  query: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec: number
): Promise<{ videoId: string; durationSec: number; title: string; artist: string } | null> {
  const key = `${query.toLowerCase()}|${expectedDurationSec}`;
  const cached = ytmLookupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      videoId: cached.videoId,
      durationSec: cached.durationSec,
      title: cached.title,
      artist: cached.artist,
    };
  }

  try {
    const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
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
    if (!res.ok) return null;
    const json = await res.json();

    const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const candidates: { videoId: string; title: string; artist: string; durationSec: number }[] = [];

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

        candidates.push({
          videoId,
          title,
          artist,
          durationSec: parseDurationSec(durationText),
        });
      }
    }

    const best = candidates
      .map((c) => ({
        c,
        score: scoreCandidateMatch({
          candidateTitle: c.title,
          candidateArtist: c.artist,
          candidateDurationSec: c.durationSec,
          targetTitle,
          targetArtist,
          fallbackQuery: query,
          expectedDurationSec,
          strictArtist: false,
        }),
      }))
      .filter((x) => x.score >= 280)
      .sort((a, b) => b.score - a.score)[0]?.c;

    if (!best) return null;

    ytmLookupCache.set(key, {
      ...best,
      expiresAt: Date.now() + 1000 * 60 * 60 * 6,
    });
    return best;
  } catch {
    return null;
  }
}

/**
 * Получаем оригинальный аудиопоток YouTube через пул Piped / Invidious инстансов (обходит блокировку IP Render).
 */
async function fetchFromPipedOrInvidious(videoId: string): Promise<AudioSource> {
  const fetchPiped = async (baseUrl: string): Promise<AudioSource> => {
    const res = await fetch(`${baseUrl}/streams/${videoId}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) throw new Error('Piped HTTP ' + res.status);
    const data = await res.json();
    const streams: any[] = Array.isArray(data?.audioStreams) ? data.audioStreams : [];
    const mp4 = streams
      .filter(
        (s) =>
          s?.url &&
          typeof s?.mimeType === 'string' &&
          s.mimeType.toLowerCase().includes('audio/mp4') &&
          !s.videoOnly
      )
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!mp4[0]?.url) throw new Error('No Piped audio/mp4');

    const probe = await fetch(mp4[0].url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!probe.ok && probe.status !== 206) throw new Error('Piped stream blocked');

    return {
      url: mp4[0].url,
      mimeType: 'audio/mp4',
      userAgent: BROWSER_UA,
      provider: 'youtube',
      isHls: false,
    };
  };

  const fetchInvidious = async (baseUrl: string): Promise<AudioSource> => {
    const res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) throw new Error('Invidious HTTP ' + res.status);
    const data = await res.json();
    const formats: any[] = Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : [];
    const mp4 = formats
      .filter(
        (f) =>
          f?.url &&
          typeof f?.type === 'string' &&
          f.type.toLowerCase().includes('audio/mp4')
      )
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

    if (!mp4[0]?.url) throw new Error('No Invidious audio/mp4');

    const probe = await fetch(mp4[0].url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!probe.ok && probe.status !== 206) throw new Error('Invidious stream blocked');

    return {
      url: mp4[0].url,
      mimeType: 'audio/mp4',
      userAgent: BROWSER_UA,
      provider: 'youtube',
      isHls: false,
    };
  };

  return Promise.any([
    ...PIPED_INSTANCES.map((u) => fetchPiped(u)),
    ...INVIDIOUS_INSTANCES.map((u) => fetchInvidious(u)),
  ]);
}

async function getSoundCloudClientId(): Promise<string> {
  if (cachedScClientId && cachedScClientId.expiresAt > Date.now()) {
    return cachedScClientId.id;
  }

  const pageRes = await fetch('https://soundcloud.com', {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(5000),
  });
  const html = await pageRes.text();
  const scriptUrls = [
    ...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
  ]
    .map((m) => m[1])
    .reverse()
    .slice(0, 14);

  for (let i = 0; i < scriptUrls.length; i += 4) {
    const batch = scriptUrls.slice(i, i + 4);
    const results = await Promise.all(
      batch.map(async (scriptUrl) => {
        try {
          const jsRes = await fetch(scriptUrl, { signal: AbortSignal.timeout(4000) });
          if (!jsRes.ok) return null;
          const js = await jsRes.text();
          const match =
            js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) ||
            js.match(/client_id=([a-zA-Z0-9]{32})/);
          return match?.[1] || null;
        } catch {
          return null;
        }
      })
    );
    const found = results.find(Boolean);
    if (found) {
      cachedScClientId = {
        id: found,
        expiresAt: Date.now() + 1000 * 60 * 60 * 12,
      };
      return found;
    }
  }

  throw new Error('SoundCloud client_id not found');
}

function isSafariCompatibleMp3Transcoding(t: any): boolean {
  if (!t?.url || typeof t.url !== 'string') return false;
  if (t.snipped === true) return false;
  if (t.url.includes('/preview/')) return false;
  const mime = String(t?.format?.mime_type || '').toLowerCase();
  if (mime.includes('ogg') || mime.includes('opus')) return false;
  return mime.includes('mpeg') || mime.includes('mp4') || mime.includes('aac') || mime === '';
}

async function searchSoundCloudRaw(query: string, clientId: string): Promise<any[]> {
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=30`;
  const res = await fetch(searchUrl, {
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) cachedScClientId = null;
    throw new Error('SC search HTTP ' + res.status);
  }
  const data = await res.json();
  return Array.isArray(data?.collection) ? data.collection : [];
}

async function fetchFromSoundCloudQuery(
  rawQuery: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec = 0
): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;

  let items = await searchSoundCloudRaw(cleanQuery, clientId);

  const strippedTitle = stripFeaturingAndTags(targetTitle);
  const primaryArtist = targetArtist.split(/[,&]|feat\.?|ft\.?/i)[0].trim();
  const altQuery = `${primaryArtist} ${strippedTitle}`.trim();

  if (altQuery && altQuery.toLowerCase() !== cleanQuery.toLowerCase()) {
    const moreItems = await searchSoundCloudRaw(altQuery, clientId).catch(() => []);
    const seenIds = new Set(items.map((it) => it?.id));
    for (const it of moreItems) {
      if (it?.id && !seenIds.has(it.id)) {
        seenIds.add(it.id);
        items.push(it);
      }
    }
  }

  const rankedTracks = items
    .filter((item) => {
      if (!Array.isArray(item?.media?.transcodings)) return false;
      if (item.policy === 'BLOCK' || item.policy === 'SNIP') return false;
      const dur = Number(item.duration || 0);
      const fullDur = Number(item.full_duration || dur);
      if (fullDur - dur > 5000) return false;
      if (dur < 85000) return false;
      return true;
    })
    .map((item) => {
      const durSec = (item.duration || 0) / 1000;
      const titleStr = String(item.title || '');
      const artistStr = [
        item.user?.username,
        item.publisher_metadata?.artist,
      ]
        .filter(Boolean)
        .join(' ');

      let score = scoreCandidateMatch({
        candidateTitle: titleStr,
        candidateArtist: artistStr,
        candidateDurationSec: durSec,
        targetTitle: cleanTrackQuery(targetTitle),
        targetArtist,
        fallbackQuery: cleanQuery,
        expectedDurationSec,
        strictArtist: true,
      });

      if (score >= 0) {
        const hasProgressive = item.media.transcodings.some(
          (t: any) => isSafariCompatibleMp3Transcoding(t) && t?.format?.protocol === 'progressive'
        );
        if (hasProgressive) score += 70;
        if (item.publisher_metadata?.isrc || item.publisher_metadata?.release_title) score += 60;
        if (item.user?.verified) score += 40;
      }

      return { item, score };
    })
    .filter((entry) => entry.score >= 340)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  for (const track of rankedTracks) {
    const progressive = track.media.transcodings.find(
      (t: any) => isSafariCompatibleMp3Transcoding(t) && t?.format?.protocol === 'progressive'
    );
    if (progressive) {
      try {
        const infoRes = await fetch(`${progressive.url}?client_id=${clientId}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info?.url && !info.url.includes('/preview/')) {
            return {
              url: info.url,
              mimeType: 'audio/mpeg',
              userAgent: BROWSER_UA,
              provider: 'soundcloud',
              isHls: false,
            };
          }
        }
      } catch {}
    }

    const hls = track.media.transcodings.find(
      (t: any) => isSafariCompatibleMp3Transcoding(t) && t?.format?.protocol === 'hls'
    );
    if (hls) {
      try {
        const infoRes = await fetch(`${hls.url}?client_id=${clientId}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info?.url && !info.url.includes('/preview/')) {
            return {
              url: info.url,
              mimeType: 'audio/mpeg',
              userAgent: BROWSER_UA,
              provider: 'soundcloud',
              isHls: true,
            };
          }
        }
      } catch {}
    }
  }

  throw new Error('No exact full match found on SoundCloud');
}

async function serveHlsAsRangedMp3(
  req: NextRequest,
  cacheKey: string,
  m3u8Url: string,
  isHead: boolean
) {
  let cached = fullAudioBufferCache.get(cacheKey);

  if (!cached || cached.expiresAt <= Date.now()) {
    const m3u8Res = await fetch(m3u8Url, { signal: AbortSignal.timeout(5000) });
    if (!m3u8Res.ok) {
      return NextResponse.json({ error: 'Failed to load HLS playlist' }, { status: 502 });
    }
    const m3u8Text = await m3u8Res.text();
    const segmentUrls = m3u8Text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http'));

    if (segmentUrls.length === 0) {
      return NextResponse.json({ error: 'Empty HLS segments' }, { status: 502 });
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    for (let i = 0; i < segmentUrls.length; i += 6) {
      const batch = segmentUrls.slice(i, i + 6);
      const buffers = await Promise.all(
        batch.map(async (segUrl) => {
          const r = await fetch(segUrl, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) throw new Error('Segment failed');
          return new Uint8Array(await r.arrayBuffer());
        })
      );
      for (const buf of buffers) {
        chunks.push(buf);
        totalBytes += buf.byteLength;
      }
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    cached = {
      bytes: merged,
      contentType: 'audio/mpeg',
      expiresAt: Date.now() + 1000 * 60 * 30,
    };
    setBufferCache(cacheKey, cached);
  }

  const total = cached.bytes.byteLength;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      const slice = cached.bytes.slice(start, end + 1);
      return new NextResponse(isHead ? null : new Uint8Array(slice), {
        status: 206,
        headers: {
          'Content-Type': cached.contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(slice.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Cache-Control': 'private, max-age=1800',
        },
      });
    }
  }

  return new NextResponse(isHead ? null : new Uint8Array(cached.bytes), {
    status: 200,
    headers: {
      'Content-Type': cached.contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
      'Cache-Control': 'private, max-age=1800',
    },
  });
}

async function getAudioSource(
  rawId: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec = 0
): Promise<AudioSource> {
  const cacheKey = `${rawId}:${expectedDurationSec}`;
  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      url: cached.url,
      mimeType: cached.mimeType,
      userAgent: cached.userAgent,
      provider: cached.provider,
      isHls: cached.isHls,
    };
  }

  let resolvedTitle = targetTitle;
  let resolvedArtist = targetArtist;
  let query = resolvedTitle
    ? resolvedArtist
      ? `${resolvedArtist} ${resolvedTitle}`
      : resolvedTitle
    : '';

  if (rawId.startsWith('ytq:')) {
    const rawYtq = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!query) query = rawYtq;
    if (!resolvedTitle) {
      const parts = rawYtq.split(' - ');
      resolvedArtist = parts.length > 1 ? parts[0].trim() : '';
      resolvedTitle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : rawYtq;
    }
  }

  let effectiveDuration = expectedDurationSec;
  if (!effectiveDuration && resolvedTitle) {
    effectiveDuration = await lookupReferenceDurationSec(resolvedTitle, resolvedArtist);
  }

  // 1. Определяем точный студийный YouTube videoId (если передан напрямую или найден через YouTube Music)
  let videoId: string | null = !rawId.startsWith('ytq:') ? rawId : null;

  if (!videoId && query) {
    const ytmHit = await searchYoutubeMusicSong(
      query,
      resolvedTitle,
      resolvedArtist,
      effectiveDuration
    );
    if (ytmHit) {
      videoId = ytmHit.videoId;
      if (!effectiveDuration && ytmHit.durationSec) {
        effectiveDuration = ytmHit.durationSec;
      }
    }
  }

  // 2. Пробуем получить оригинальный студийный трек через Piped / Invidious
  if (videoId) {
    try {
      const pipedSource = await fetchFromPipedOrInvidious(videoId);
      streamUrlCache.set(cacheKey, {
        ...pipedSource,
        expiresAt: Date.now() + 1000 * 60 * 60,
      });
      return pipedSource;
    } catch {
      // Если все инстансы недоступны, подтягиваем метаданные (если ещё нет) и идём в SoundCloud
      if (!resolvedTitle) {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(3000) }
        ).catch(() => null);
        if (oembedRes?.ok) {
          const data = await oembedRes.json();
          resolvedTitle = cleanTrackQuery(String(data?.title || ''));
          resolvedArtist = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
          query = `${resolvedArtist} ${resolvedTitle}`.trim();
          if (!effectiveDuration && resolvedTitle) {
            effectiveDuration = await lookupReferenceDurationSec(resolvedTitle, resolvedArtist);
          }
        }
      }
    }
  }

  // 3. Строгий поиск на SoundCloud (обязательное совпадение артиста, названия и точной длительности)
  const scSource = await fetchFromSoundCloudQuery(
    query,
    resolvedTitle,
    resolvedArtist,
    effectiveDuration
  );

  streamUrlCache.set(cacheKey, {
    ...scSource,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });

  return scSource;
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

    const rawDuration = Number(req.nextUrl.searchParams.get('d') || '0') || 0;
    const expectedDurationSec = rawDuration > 10000 ? Math.round(rawDuration / 1000) : rawDuration;
    const targetTitle = (req.nextUrl.searchParams.get('t') || '').trim();
    const targetArtist = (req.nextUrl.searchParams.get('a') || '').trim();
    const cacheKey = `${rawId}:${expectedDurationSec}`;

    const source = await getAudioSource(rawId, targetTitle, targetArtist, expectedDurationSec);

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      if (source.isHls) {
        await serveHlsAsRangedMp3(req, cacheKey, source.url, true);
      }
      return NextResponse.json({ ok: true });
    }

    if (source.isHls) {
      return serveHlsAsRangedMp3(req, cacheKey, source.url, isHead);
    }

    const rangeHeader = req.headers.get('range');
    const headers: Record<string, string> = { 'User-Agent': source.userAgent };
    if (rangeHeader) headers['Range'] = rangeHeader;

    let upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers,
    });

    if (!upstream.ok && upstream.status !== 206) {
      streamUrlCache.delete(cacheKey);
      const retrySource = await getAudioSource(rawId, targetTitle, targetArtist, expectedDurationSec);
      if (retrySource.isHls) {
        return serveHlsAsRangedMp3(req, cacheKey, retrySource.url, isHead);
      }
      upstream = await fetch(retrySource.url, {
        method: isHead ? 'HEAD' : 'GET',
        headers,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
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