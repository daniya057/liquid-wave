import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

interface AudioSource {
  url: string;
  mimeType: string;
  userAgent: string;
  provider: 'youtube' | 'soundcloud';
  isHls?: boolean;
}

interface CachedHeadChunk {
  bytes: Uint8Array;
  contentType: string;
  totalSize: number;
  expiresAt: number;
}

const streamUrlCache = new Map<string, AudioSource & { expiresAt: number }>();
const headChunkCache = new Map<string, CachedHeadChunk>();
const resolvedSongCache = new Map<
  string,
  { videoId: string; durationSec: number; expiresAt: number }
>();
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
  'час',
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

function hasSuspiciousBrackets(title: string, allowedQuery: string): boolean {
  const qLower = allowedQuery.toLowerCase();
  const brackets = title.match(/[\(\[][^\)\]]+[\)\]]/g) || [];
  for (const b of brackets) {
    const inner = b.slice(1, -1).trim().toLowerCase();
    if (!inner) continue;
    const isSafe =
      /^(official(\s+(audio|video|music\s+video))?|audio|video|lyrics?|lyric\s+video|explicit|clean|remastered(\s+\d{4})?|hd|hq|feat\.?.*|ft\.?.*)$/i.test(
        inner
      );
    if (!isSafe && !qLower.includes(inner)) {
      return true;
    }
  }
  return false;
}

function scoreCandidateMatch(params: {
  candidateTitle: string;
  candidateArtist: string;
  candidateDurationSec: number;
  targetTitle: string;
  targetArtist: string;
  fallbackQuery: string;
  expectedDurationSec: number;
}): number {
  const {
    candidateTitle,
    candidateArtist,
    candidateDurationSec,
    targetTitle,
    targetArtist,
    fallbackQuery,
    expectedDurationSec,
  } = params;

  const allowedContext = `${targetArtist} ${targetTitle} ${fallbackQuery}`.trim();
  const candCombined = `${candidateArtist} ${candidateTitle}`.toLowerCase();

  // 1. Жёсткая отсечка ремиксов, миксов, полных альбомов, каверов, замедленных версий и сниппетов
  if (hasUnwantedVariant(candCombined, allowedContext)) {
    return -10000;
  }

  // 2. Жёсткая отсечка обрезанных (1-минутных) и слишком длинных (30-минутных) записей
  const allowsShort = /(?:^|\s)(?:intro|outro|skit|interlude|интро|аутро|скит|интерлюдия)(?:\s|$)/i.test(
    allowedContext
  );
  const allowsLong = /(?:^|\s)(?:mix|set|album|podcast|live|symphony|микс|сет|альбом|подкаст)(?:\s|$)/i.test(
    allowedContext
  );

  if (candidateDurationSec > 0) {
    if (!allowsShort && candidateDurationSec < 75 && (expectedDurationSec === 0 || expectedDurationSec >= 85)) {
      return -10000;
    }
    if (!allowsLong && candidateDurationSec > 630 && (expectedDurationSec === 0 || expectedDurationSec <= 600)) {
      return -10000;
    }
    if (expectedDurationSec > 0) {
      const diff = Math.abs(candidateDurationSec - expectedDurationSec);
      if (diff > 30) {
        return -10000;
      }
    }
  }

  // 3. Проверка совпадения названия трека (с поддержкой транслита и очисткой feat.)
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
  const minTitleRatio = titleTokens.length <= 2 ? 1.0 : 0.65;
  if (matchedTitleCount === 0 || titleRatio < minTitleRatio) {
    return -10000;
  }

  let score = Math.round(titleRatio * 240);

  // 4. Проверка совпадения исполнителя
  let artistMatched = false;
  if (targetArtist) {
    const primaryArtist = targetArtist.split(/[,&]|feat\.?|ft\.?/i)[0].trim() || targetArtist;
    const artistTokens = tokenize(primaryArtist);
    if (artistTokens.length > 0) {
      let matchedArtistCount = 0;
      for (const tok of artistTokens) {
        if (tokensMatch(tok, candAllTokens)) matchedArtistCount++;
      }
      if (matchedArtistCount > 0) {
        artistMatched = true;
        score += Math.round((matchedArtistCount / artistTokens.length) * 200);
      } else {
        // Если артист вообще не совпал — пропускаем только при точном совпадении длительности и 100% названия (релиз от лейбла)
        const exactDurationMatch =
          expectedDurationSec > 0 &&
          candidateDurationSec > 0 &&
          Math.abs(candidateDurationSec - expectedDurationSec) <= 3;
        if (!exactDurationMatch || titleRatio < 1.0) {
          return -10000;
        }
        score -= 100;
      }
    }
  }

  if (hasSuspiciousBrackets(candidateTitle, allowedContext)) {
    score -= 180;
  }

  // 5. Бонусы и штрафы за длительность
  if (expectedDurationSec > 0 && candidateDurationSec > 0) {
    const diff = Math.abs(candidateDurationSec - expectedDurationSec);
    if (diff <= 3) score += 260;
    else if (diff <= 8) score += 160;
    else if (diff <= 15) score += 40;
    else score -= 140;
  } else if (artistMatched && candidateDurationSec >= 90 && candidateDurationSec <= 420) {
    score += 60;
  }

  return score;
}

function setHeadChunkCache(key: string, entry: CachedHeadChunk) {
  if (headChunkCache.size >= 12) {
    const oldestKey = headChunkCache.keys().next().value;
    if (oldestKey) headChunkCache.delete(oldestKey);
  }
  headChunkCache.set(key, entry);
}

async function warmHeadChunk(cacheKey: string, source: AudioSource) {
  if (source.isHls) return;
  const existing = headChunkCache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) return;

  try {
    const res = await fetch(source.url, {
      headers: {
        Range: 'bytes=0-524287',
        'User-Agent': source.userAgent,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 206) return;

    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0) return;

    const contentRange = res.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalSize = totalMatch ? Number(totalMatch[1]) : ab.byteLength;

    setHeadChunkCache(cacheKey, {
      bytes: new Uint8Array(ab),
      contentType: res.headers.get('content-type') || source.mimeType,
      totalSize,
      expiresAt: Date.now() + 1000 * 60 * 30,
    });
  } catch {
    // игнорируем ошибки прогрева
  }
}

async function probeAudioUrl(url: string, userAgent: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-1023',
        'User-Agent': userAgent,
      },
      signal: AbortSignal.timeout(3500),
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
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

async function resolveSongOnYoutubeMusic(
  rawQuery: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec = 0
): Promise<{ videoId: string; durationSec: number } | null> {
  const cleanQuery = cleanTrackQuery(rawQuery) || rawQuery;
  const cacheKey = `${cleanQuery.toLowerCase()}:${expectedDurationSec}`;

  const cached = resolvedSongCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { videoId: cached.videoId, durationSec: cached.durationSec };
  }

  const songs = await searchYoutubeMusicSongs(cleanQuery);
  if (!songs.length) return null;

  const ranked = songs
    .map((item) => ({
      item,
      score: scoreCandidateMatch({
        candidateTitle: item.title,
        candidateArtist: item.channel,
        candidateDurationSec: item.durationSec,
        targetTitle: cleanTrackQuery(targetTitle),
        targetArtist,
        fallbackQuery: cleanQuery,
        expectedDurationSec,
      }),
    }))
    .filter((x) => x.score >= 120)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]?.item;
  if (best?.videoId) {
    const resolved = {
      videoId: best.videoId,
      durationSec: best.durationSec || expectedDurationSec,
    };
    resolvedSongCache.set(cacheKey, {
      ...resolved,
      expiresAt: Date.now() + 1000 * 60 * 60 * 6,
    });
    return resolved;
  }
  return null;
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
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=25`;
  const res = await fetch(searchUrl, {
    signal: AbortSignal.timeout(6000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
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

  // Если с feat. ничего не нашлось — пробуем очищенное название + основного артиста
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
      // Отбрасываем 30-60 секундные обрезанные превью SoundCloud Go+
      if (fullDur - dur > 5000) return false;
      if (dur < 75000) return false;
      return true;
    })
    .map((item) => {
      const durSec = (item.duration || 0) / 1000;
      const titleStr = String(item.title || '');
      const artistStr = String(item.user?.username || '');

      let score = scoreCandidateMatch({
        candidateTitle: titleStr,
        candidateArtist: artistStr,
        candidateDurationSec: durSec,
        targetTitle: cleanTrackQuery(targetTitle),
        targetArtist,
        fallbackQuery: cleanQuery,
        expectedDurationSec,
      });

      if (score >= 0) {
        if (item.publisher_metadata?.isrc || item.publisher_metadata?.release_title) score += 90;
        if (item.user?.verified) score += 50;
      }

      return { item, score };
    })
    .filter((entry) => entry.score >= 120)
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
            const ok = await probeAudioUrl(info.url, BROWSER_UA);
            if (ok) {
              return {
                url: info.url,
                mimeType: 'audio/mpeg',
                userAgent: BROWSER_UA,
                provider: 'soundcloud',
                isHls: false,
              };
            }
          }
        }
      } catch {
        // пробуем hls или следующий трек
      }
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
              mimeType: 'application/vnd.apple.mpegurl',
              userAgent: BROWSER_UA,
              provider: 'soundcloud',
              isHls: true,
            };
          }
        }
      } catch {
        // пробуем следующий трек
      }
    }
  }

  throw new Error('No full matching MP3 stream on SoundCloud');
}

async function fetchYoutubeMetadataFallback(
  videoId: string
): Promise<{ title: string; artist: string; query: string }> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (res.ok) {
      const data = await res.json();
      const title = cleanTrackQuery(String(data?.title || ''));
      const artist = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
      if (title) {
        const query =
          artist && !title.toLowerCase().includes(artist.toLowerCase())
            ? `${artist} ${title}`
            : title;
        return { title, artist, query };
      }
    }
  } catch {
    // пробуем вытащить title из страницы YouTube
  }

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(4000),
  });
  const html = await pageRes.text();
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const rawPageTitle = (titleMatch?.[1] || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  const cleaned = cleanTrackQuery(rawPageTitle);
  if (!cleaned) throw new Error('Unable to resolve track title');
  return { title: cleaned, artist: '', query: cleaned };
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

    if (data?.playabilityStatus?.status && data.playabilityStatus.status !== 'OK') {
      throw new Error('Playability: ' + data.playabilityStatus.status);
    }

    const formats = [
      ...(data?.streamingData?.adaptiveFormats || []),
      ...(data?.streamingData?.formats || []),
    ];

    const mp4Audio = formats
      .filter(
        (f: any) =>
          f.url &&
          typeof f.mimeType === 'string' &&
          f.mimeType.toLowerCase().includes('audio/mp4') &&
          f.audioTrack?.audioIsDefault !== false
      )
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!mp4Audio[0]?.url) throw new Error('No audio/mp4 format');

    const isReachable = await probeAudioUrl(mp4Audio[0].url, ua);
    if (!isReachable) throw new Error('YouTube stream URL returned 403');

    return {
      url: mp4Audio[0].url,
      mimeType: 'audio/mp4',
      userAgent: ua,
      provider: 'youtube',
      isHls: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function tryAllYoutubeClients(videoId: string): Promise<AudioSource> {
  return Promise.any([
    fetchInnerTubeMp4(
      videoId,
      'ANDROID_VR',
      '1.60.19',
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      {
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
        androidSdkVersion: 32,
      }
    ),
    fetchInnerTubeMp4(
      videoId,
      'IOS',
      '19.45.4',
      'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
      { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
    ),
  ]);
}

async function resolveFallbackSoundCloud(
  rawId: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec = 0
): Promise<AudioSource> {
  let effectiveDuration = expectedDurationSec;

  // Если длительность трека не была передана (например, при импорте плейлиста), узнаём её через YouTube Music
  if (!effectiveDuration && (targetTitle || rawId.startsWith('ytq:'))) {
    const lookupQuery = targetTitle
      ? targetArtist
        ? `${targetArtist} ${targetTitle}`
        : targetTitle
      : safeDecode(rawId.split(':').slice(2).join(':')).trim();
    const ytm = await resolveSongOnYoutubeMusic(lookupQuery, targetTitle, targetArtist, 0);
    if (ytm?.durationSec) {
      effectiveDuration = ytm.durationSec;
    }
  }

  if (targetTitle) {
    const query = targetArtist ? `${targetArtist} ${targetTitle}` : targetTitle;
    return fetchFromSoundCloudQuery(query, targetTitle, targetArtist, effectiveDuration);
  }

  if (rawId.startsWith('ytq:')) {
    const query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    const parts = query.split(' - ');
    const guessArtist = parts.length > 1 ? parts[0].trim() : '';
    const guessTitle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : query;
    return fetchFromSoundCloudQuery(query, guessTitle, guessArtist, effectiveDuration);
  }

  const meta = await fetchYoutubeMetadataFallback(rawId);
  return fetchFromSoundCloudQuery(meta.query, meta.title, meta.artist, effectiveDuration);
}

async function getAudioSource(
  rawId: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec = 0,
  skipYoutube = false
): Promise<AudioSource> {
  const cacheKey = `${rawId}:${expectedDurationSec}`;
  if (!skipYoutube) {
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
  }

  let videoId: string | null = rawId;
  let effectiveDuration = expectedDurationSec;
  let query = targetTitle
    ? targetArtist
      ? `${targetArtist} ${targetTitle}`
      : targetTitle
    : '';
  let resolvedTitle = targetTitle;
  let resolvedArtist = targetArtist;

  if (rawId.startsWith('ytq:')) {
    const rawYtq = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!query) query = rawYtq;
    if (!resolvedTitle) {
      const parts = rawYtq.split(' - ');
      resolvedArtist = parts.length > 1 ? parts[0].trim() : '';
      resolvedTitle = parts.length > 1 ? parts.slice(1).join(' - ').trim() : rawYtq;
    }
    if (!query) throw new Error('Empty track query');

    const ytmResolved = await resolveSongOnYoutubeMusic(
      query,
      resolvedTitle,
      resolvedArtist,
      effectiveDuration
    );
    videoId = skipYoutube ? null : ytmResolved?.videoId || null;
    if (!effectiveDuration && ytmResolved?.durationSec) {
      effectiveDuration = ytmResolved.durationSec;
    }
  }

  let resolved: AudioSource;

  if (videoId && !skipYoutube) {
    try {
      resolved = await tryAllYoutubeClients(videoId);
    } catch {
      resolved = await resolveFallbackSoundCloud(
        rawId,
        resolvedTitle,
        resolvedArtist,
        effectiveDuration
      );
    }
  } else {
    resolved = await resolveFallbackSoundCloud(
      rawId,
      resolvedTitle,
      resolvedArtist,
      effectiveDuration
    );
  }

  streamUrlCache.set(cacheKey, {
    ...resolved,
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
        'Cache-Control': 'private, max-age=1800',
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
        'Cache-Control': 'private, max-age=1800',
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const segUrl of segmentUrls) {
          if (req.signal.aborted) break;
          let segRes = await fetch(segUrl, { signal: req.signal }).catch(() => null);
          if (!segRes || !segRes.ok) {
            segRes = await fetch(segUrl, { signal: req.signal }).catch(() => null);
          }
          if (!segRes || !segRes.ok || !segRes.body) continue;
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
      'Cache-Control': 'private, max-age=1800',
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

    const rawDuration = Number(req.nextUrl.searchParams.get('d') || '0') || 0;
    const expectedDurationSec = rawDuration > 10000 ? Math.round(rawDuration / 1000) : rawDuration;
    const targetTitle = (req.nextUrl.searchParams.get('t') || '').trim();
    const targetArtist = (req.nextUrl.searchParams.get('a') || '').trim();
    const cacheKey = `${rawId}:${expectedDurationSec}`;

    if (req.nextUrl.searchParams.get('resolve') === '1') {
      const resolved = rawId.startsWith('ytq:')
        ? await resolveSongOnYoutubeMusic(
            safeDecode(rawId.split(':').slice(2).join(':')).trim(),
            targetTitle,
            targetArtist,
            expectedDurationSec
          )
        : { videoId: rawId, durationSec: expectedDurationSec };
      return NextResponse.json({ videoId: resolved?.videoId || null });
    }

    let source = await getAudioSource(rawId, targetTitle, targetArtist, expectedDurationSec);

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      await warmHeadChunk(cacheKey, source);
      return NextResponse.json({ ok: true });
    }

    if (source.isHls) {
      return handleHlsStream(req, source.url, isHead);
    }

    const rangeHeader = req.headers.get('range');
    const cachedHead = headChunkCache.get(cacheKey);

    if (!isHead && rangeHeader && cachedHead && cachedHead.expiresAt > Date.now()) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (start === 0 && end < cachedHead.bytes.byteLength) {
          const slice = cachedHead.bytes.slice(0, end + 1);
          return new NextResponse(Buffer.from(slice), {
            status: 206,
            headers: {
              'Content-Type': cachedHead.contentType,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(slice.byteLength),
              'Content-Range': `bytes 0-${end}/${cachedHead.totalSize}`,
              'Cache-Control': 'private, max-age=1800',
            },
          });
        }
      }
    }

    const fetchUpstream = async (src: AudioSource) => {
      const headers: Record<string, string> = {
        'User-Agent': src.userAgent,
      };
      if (rangeHeader) {
        headers['Range'] = rangeHeader;
      }
      return fetch(src.url, {
        method: isHead ? 'HEAD' : 'GET',
        headers,
      });
    };

    let upstream = await fetchUpstream(source);

    if (!upstream.ok && upstream.status !== 206) {
      streamUrlCache.delete(cacheKey);
      headChunkCache.delete(cacheKey);

      source = await resolveFallbackSoundCloud(
        rawId,
        targetTitle,
        targetArtist,
        expectedDurationSec
      );
      streamUrlCache.set(cacheKey, {
        ...source,
        expiresAt: Date.now() + 1000 * 60 * 60,
      });
      if (source.isHls) {
        return handleHlsStream(req, source.url, isHead);
      }
      upstream = await fetchUpstream(source);
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