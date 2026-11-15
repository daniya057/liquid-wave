import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface AudioSource {
  url: string;
  mimeType: string;
  userAgent: string;
  provider: 'youtube' | 'soundcloud';
  isHls?: boolean;
  bufferKey?: string;
}

interface CachedBuffer {
  bytes: Uint8Array;
  contentType: string;
  expiresAt: number;
}

const streamUrlCache = new Map<string, AudioSource & { expiresAt: number }>();
const fullAudioBufferCache = new Map<string, CachedBuffer>();
const inFlightSourcePromises = new Map<string, Promise<AudioSource>>();
const inFlightBufferPromises = new Map<string, Promise<CachedBuffer>>();
const ytmLookupCache = new Map<
  string,
  { videoId: string; durationSec: number; title: string; artist: string; expiresAt: number }
>();
const durationLookupCache = new Map<string, { durationSec: number; expiresAt: number }>();
let cachedScClientId: { id: string; expiresAt: number } | null = null;
let ytBlockedUntil = 0;

const UNWANTED_MODIFIERS = [
  'remix',
  'remixed',
  'rmx',
  'edit',
  'vip',
  'flip',
  'bootleg',
  'mashup',
  'mash-up',
  'rework',
  're-work',
  're-edit',
  'reimagined',
  'live',
  'concert',
  'tour',
  'festival',
  'session',
  'acoustic',
  'unplugged',
  'fingerstyle',
  'orchestral',
  'symphonic',
  'string quartet',
  '8-bit',
  '8bit',
  'lofi',
  'lo-fi',
  'slowed',
  'reverb',
  'sped up',
  'speed up',
  'speedup',
  'nightcore',
  '8d',
  '8-d',
  'bass boosted',
  'bassboost',
  'cover',
  'ai cover',
  'rvc',
  'sovits',
  'karaoke',
  'instrumental',
  'acapella',
  'a capella',
  'tribute',
  'parody',
  'demo',
  'rehearsal',
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
  'hardstyle',
  'phonk',
  'dubstep',
  'dnb',
  'drum and bass',
  'drum cover',
  'guitar cover',
  'bass cover',
  'piano cover',
  'vocal cover',
  'russian version',
  'на русском',
  'под гитару',
  'на гитаре',
  'на пианино',
  'ии кавер',
  'ремикс',
  'концерт',
  'лайв',
  'акустик',
  'замедл',
  'ускор',
  'кавер',
  'минус',
  'инструментал',
  'акапелла',
  'пародия',
  'бит',
  'микс',
  'мегамикс',
  'полный альбом',
  'альбом',
  'сборник',
  'подкаст',
  'рингтон',
  'фонк',
  'лоуфай',
];

const SUBSTRING_BANNED_WORDS = [
  'remix',
  'bootleg',
  'mashup',
  'nightcore',
  'slowed',
  'speedup',
  'bassboost',
  'karaoke',
  'acapella',
  'ringtone',
  'fingerstyle',
  'ремикс',
  'кавер',
  'найткор',
  'замедл',
];

const TAG_LIST_BANNED_RE =
  /(?:^|[\s"])(?:remix|remixed|rmx|bootleg|mashup|nightcore|slowed|sped\s*up|speedup|karaoke|instrumental|acapella|cover|ai\s*cover|live|acoustic|hardstyle|phonk|lofi|lo-fi|8d|ремикс|кавер|замедл|ускор|минус|лайв)(?:$|[\s"])/i;

const DESCRIPTION_BANNED_RE =
  /\b(?:my\s+cover|guitar\s+cover|drum\s+cover|vocal\s+cover|piano\s+cover|bass\s+cover|ai\s+cover|remix\s+by|bootleg|mashup|slowed\s*\+?\s*reverb|nightcore|instrumental\s+version|karaoke\s+version|кавер\s+на|мой\s+ремикс|минус\s+песни)\b/i;

const BENIGN_BRACKET_RE =
  /^(?:\d{4}|official|official\s+audio|official\s+video|official\s+music\s+video|music\s+video|lyric|lyrics|lyric\s+video|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|original|original\s+mix|album\s+version|single\s+version|full|full\s+song|full\s+track|remaster(?:ed)?(?:\s+\d{4})?|from\s+.+|feat\.?\s+.+|ft\.?\s+.+|with\s+.+|prod\.?\s+.+|клип|премьера|текст|аудио|видео|официальный|оригинал)$/i;

const DASH_RELEASE_TAG_RE =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|mix|original\s+mix|album\s+version|single\s+version|radio\s+edit|explicit|clean|bonus\s+track|deluxe(?:\s+edition)?|anniversary(?:\s+edition)?|mono|stereo)\b.*$/i;

const NOISE_WORDS = new Set([
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
  'topic',
  'explicit',
  'clean',
  'remastered',
  'remaster',
  'deluxe',
  'edition',
  'anniversary',
  'bonus',
  'original',
  'version',
  'full',
  'song',
  'track',
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

function extractMainArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+|,\s*/i)[0].trim();
}

function stripFeaturingAndTags(raw: string): string {
  return raw
    .replace(DASH_RELEASE_TAG_RE, '')
    .replace(/\((?:feat\.?|ft\.?|with|prod\.?)\s+[^)]+\)/gi, '')
    .replace(/\[(?:feat\.?|ft\.?|with|prod\.?)\s+[^\]]+\]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/i, '')
    .replace(
      /\((?:\d{4}|official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|original(?:\s+mix)?|album\s+version|single\s+version|full(?:\s+song|\s+track)?|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^)]*\)/gi,
      ''
    )
    .replace(
      /\[(?:\d{4}|official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|original(?:\s+mix)?|album\s+version|single\s+version|full(?:\s+song|\s+track)?|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^\]]*\]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanTrackQuery(raw: string): string {
  return raw
    .replace(DASH_RELEASE_TAG_RE, '')
    .replace(
      /\((?:\d{4}|official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|original(?:\s+mix)?|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^)]*\)/gi,
      ''
    )
    .replace(
      /\[(?:\d{4}|official|music|lyric|lyrics|audio|video|visualizer|hd|hq|4k|8k|explicit|clean|original(?:\s+mix)?|album\s+version|single\s+version|full(?:\s+song|\s+track)?|remaster(?:ed)?(?:\s+\d{4})?|клип|премьера|текст|аудио|видео)[^\]]*\]/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return matches.filter((w) => !NOISE_WORDS.has(w));
}

function buildTokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const tok of tokenize(text)) {
    set.add(tok);
    const tr = transliterate(tok);
    if (tr.length > 0) set.add(tr);
  }
  return set;
}

function tokensMatch(token: string, candSet: Set<string>): boolean {
  if (candSet.has(token)) return true;
  const tr = transliterate(token);
  if (tr.length > 0 && candSet.has(tr)) return true;
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

  for (const sub of SUBSTRING_BANNED_WORDS) {
    if (!qLower.includes(sub) && tLower.includes(sub)) {
      return true;
    }
  }

  return UNWANTED_MODIFIERS.some((mod) => {
    if (qLower.includes(mod)) return false;
    const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u');
    return regex.test(tLower);
  });
}

function hasSuspiciousParenthetical(candidateTitle: string, allowedContext: string): boolean {
  const allowedLower = allowedContext.toLowerCase();
  const matches = [...candidateTitle.matchAll(/[\(\[]([^\)\]]+)[\)\]]/g)];
  for (const m of matches) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    if (allowedLower.includes(inner.toLowerCase())) continue;
    if (BENIGN_BRACKET_RE.test(inner)) continue;
    return true;
  }
  return false;
}

function setBufferCache(key: string, entry: CachedBuffer) {
  if (fullAudioBufferCache.size >= 24) {
    const oldestKey = fullAudioBufferCache.keys().next().value;
    if (oldestKey) fullAudioBufferCache.delete(oldestKey);
  }
  fullAudioBufferCache.set(key, entry);
}

async function lookupReferenceDurationSec(title: string, artist: string): Promise<number> {
  const cleanT = stripFeaturingAndTags(title);
  const primaryA = extractMainArtist(artist);
  const key = `${primaryA.toLowerCase()}|${cleanT.toLowerCase()}`;
  if (!cleanT) return 0;

  const cached = durationLookupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.durationSec;
  }

  const targetTitleSet = buildTokenSet(cleanT);
  const targetArtistSet = buildTokenSet(primaryA);
  const allowedCtx = `${primaryA} ${cleanT}`;

  const isValidStudioMatch = (candTitle: string, candArtist: string, durSec: number): boolean => {
    if (durSec < 45 || durSec > 900) return false;
    if (hasUnwantedVariant(`${candArtist} ${candTitle}`, allowedCtx)) return false;
    const cTitleTokens = tokenize(stripFeaturingAndTags(candTitle));
    const cArtistSet = buildTokenSet(candArtist);
    const titleOk =
      cTitleTokens.length > 0 && cTitleTokens.every((t) => tokensMatch(t, targetTitleSet));
    const artistOk =
      targetArtistSet.size === 0 ||
      [...targetArtistSet].some((t) => tokensMatch(t, cArtistSet));
    return titleOk && artistOk;
  };

  const term = `${primaryA} ${cleanT}`.trim();

  const [deezerDur, itunesDur, lrclibDur] = await Promise.all([
    (async () => {
      try {
        const res = await fetch(
          `https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=6`,
          { signal: AbortSignal.timeout(2000) }
        );
        if (!res.ok) return 0;
        const data = await res.json();
        const items = Array.isArray(data?.data) ? data.data : [];
        const hit = items.find((it: any) =>
          isValidStudioMatch(
            String(it?.title || ''),
            String(it?.artist?.name || ''),
            Number(it?.duration || 0)
          )
        );
        return hit ? Number(hit.duration) : 0;
      } catch {
        return 0;
      }
    })(),

    (async () => {
      try {
        const res = await fetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=6`,
          { signal: AbortSignal.timeout(2000) }
        );
        if (!res.ok) return 0;
        const data = await res.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        const hit = results.find((r: any) =>
          isValidStudioMatch(
            String(r?.trackName || ''),
            String(r?.artistName || ''),
            Math.round(Number(r?.trackTimeMillis || 0) / 1000)
          )
        );
        return hit ? Math.round(Number(hit.trackTimeMillis) / 1000) : 0;
      } catch {
        return 0;
      }
    })(),

    (async () => {
      try {
        const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanT)}&artist_name=${encodeURIComponent(primaryA)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return 0;
        const list = await res.json();
        if (!Array.isArray(list)) return 0;
        const hit = list.find((item: any) =>
          isValidStudioMatch(
            String(item?.trackName || ''),
            String(item?.artistName || ''),
            Math.round(Number(item?.duration || 0))
          )
        );
        return hit ? Math.round(Number(hit.duration)) : 0;
      } catch {
        return 0;
      }
    })(),
  ]);

  const resolved = deezerDur || itunesDur || lrclibDur || 0;
  if (resolved > 0) {
    durationLookupCache.set(key, {
      durationSec: resolved,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24,
    });
  }
  return resolved;
}

function scoreCandidateMatch(params: {
  candidateTitle: string;
  candidateArtist: string;
  candidateGenre?: string;
  candidateTags?: string;
  candidateDescription?: string;
  candidateDurationSec: number;
  targetTitle: string;
  targetArtist: string;
  fallbackQuery: string;
  expectedDurationSec: number;
  maxDurationToleranceSec?: number;
  maxExtraWords?: number;
}): number {
  const {
    candidateTitle,
    candidateArtist,
    candidateGenre = '',
    candidateTags = '',
    candidateDescription = '',
    candidateDurationSec,
    targetTitle,
    targetArtist,
    fallbackQuery,
    expectedDurationSec,
    maxDurationToleranceSec,
    maxExtraWords = 1,
  } = params;

  const allowedContext = `${targetArtist} ${targetTitle} ${fallbackQuery}`.trim();
  const titleAndArtistLower = `${candidateArtist} ${candidateTitle} ${candidateGenre}`.toLowerCase();

  // 1. Жёстко блокируем ремиксы, каверы, бутлеги, slowed/sped up, live, миксы
  if (hasUnwantedVariant(titleAndArtistLower, allowedContext)) {
    return -10000;
  }

  // 2. Проверяем теги и описание SoundCloud
  const queryWantsVariant = hasUnwantedVariant(allowedContext, '');
  if (!queryWantsVariant) {
    if (candidateTags && TAG_LIST_BANNED_RE.test(candidateTags)) {
      return -10000;
    }
    if (candidateDescription && DESCRIPTION_BANNED_RE.test(candidateDescription.slice(0, 300))) {
      return -10000;
    }
  }

  // 3. Блокируем подозрительные пометки в скобках
  if (hasSuspiciousParenthetical(candidateTitle, allowedContext)) {
    return -10000;
  }

  // 4. Жёсткая проверка длительности
  const allowsShort = /(?:^|\s)(?:intro|outro|skit|interlude|интро|аутро|скит|интерлюдия)(?:\s|$)/i.test(
    allowedContext
  );
  const allowsLong = /(?:^|\s)(?:mix|set|album|podcast|live|symphony|микс|сет|альбом|подкаст)(?:\s|$)/i.test(
    allowedContext
  );

  if (candidateDurationSec > 0) {
    if (expectedDurationSec > 0) {
      const tolerance =
        maxDurationToleranceSec ?? Math.max(8, Math.min(14, Math.round(expectedDurationSec * 0.04)));
      if (Math.abs(candidateDurationSec - expectedDurationSec) > tolerance) {
        return -10000;
      }
    } else {
      if (!allowsShort && candidateDurationSec < 75) return -10000;
      if (!allowsLong && candidateDurationSec > 540) return -10000;
    }
  }

  // 5. Двусторонняя проверка совпадения слов названия
  const candAllTokens = buildTokenSet(`${candidateArtist} ${candidateTitle}`);
  const strippedCandTitle = stripFeaturingAndTags(candidateTitle);
  const candTitleTokenList = tokenize(strippedCandTitle);
  const candTitleTokens = buildTokenSet(strippedCandTitle);

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
  const minTitleRatio = titleTokens.length <= 3 ? 1.0 : 0.85;
  if (matchedTitleCount === 0 || titleRatio < minTitleRatio) {
    return -10000;
  }

  // Проверяем лишние слова в заголовке кандидата (кроме самого трека и имени артиста)
  const expectedKnownTokens = buildTokenSet(`${targetArtist} ${coreTitle}`);
  let unexplainedExtraWords = 0;
  for (const tok of candTitleTokenList) {
    if (!tokensMatch(tok, expectedKnownTokens)) {
      unexplainedExtraWords++;
    }
  }

  if (unexplainedExtraWords > maxExtraWords) {
    return -10000;
  }

  let score = Math.round(titleRatio * 240);
  if (unexplainedExtraWords === 0) {
    score += 220;
  } else {
    score -= unexplainedExtraWords * 90;
  }

  // 6. Проверка присутствия артиста в метаданных/заголовке ИЛИ тегах/описании
  if (targetArtist) {
    const primaryArtist = extractMainArtist(targetArtist) || targetArtist;
    const artistTokens = tokenize(primaryArtist);
    if (artistTokens.length > 0) {
      let matchedArtistCount = 0;
      for (const tok of artistTokens) {
        if (tokensMatch(tok, candAllTokens)) matchedArtistCount++;
      }

      if (matchedArtistCount > 0) {
        score += Math.round((matchedArtistCount / artistTokens.length) * 260);
      } else {
        // Проверяем теги и описание (часто перезаливы называют просто "One", а группу пишут в тегах)
        const metaTokenSet = buildTokenSet(`${candidateTags} ${candidateDescription.slice(0, 250)}`);
        const matchedInMeta = artistTokens.filter((tok) => tokensMatch(tok, metaTokenSet)).length;

        if (matchedInMeta > 0) {
          score += Math.round((matchedInMeta / artistTokens.length) * 150);
        } else {
          const exactDurationMatch =
            expectedDurationSec > 0 &&
            candidateDurationSec > 0 &&
            Math.abs(candidateDurationSec - expectedDurationSec) <= 4;
          if (!exactDurationMatch || titleRatio < 1.0 || unexplainedExtraWords > 0) {
            return -10000;
          }
          score -= 40;
        }
      }
    }
  }

  // 7. Бонусы за точную длительность
  if (expectedDurationSec > 0 && candidateDurationSec > 0) {
    const diff = Math.abs(candidateDurationSec - expectedDurationSec);
    if (diff <= 2) score += 300;
    else if (diff <= 5) score += 200;
    else if (diff <= 10) score += 100;
  }

  return score;
}

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
      signal: AbortSignal.timeout(2500),
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
        }),
      }))
      .filter((x) => x.score >= 250)
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

async function fetchInnerTubeMp4(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  extraClient: Record<string, any> = {}
): Promise<AudioSource> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(1800),
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

  const probe = await fetch(mp4Audio[0].url, {
    method: 'GET',
    headers: { Range: 'bytes=0-1023', 'User-Agent': ua },
    signal: AbortSignal.timeout(1500),
  });
  if (!probe.ok && probe.status !== 206) throw new Error('YouTube stream blocked');

  return {
    url: mp4Audio[0].url,
    mimeType: 'audio/mp4',
    userAgent: ua,
    provider: 'youtube',
    isHls: false,
  };
}

async function tryYoutubeDirect(videoId: string): Promise<AudioSource> {
  if (ytBlockedUntil > Date.now()) {
    throw new Error('YouTube temporarily bypassed');
  }
  try {
    return await Promise.any([
      fetchInnerTubeMp4(videoId, 'WEB_EMBEDDED_PLAYER', '1.20260101.00.00', BROWSER_UA, {
        thirdParty: { embedUrl: 'https://www.youtube.com/' },
      }),
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
  } catch (err) {
    ytBlockedUntil = Date.now() + 1000 * 60 * 10;
    throw err;
  }
}

async function getSoundCloudClientId(): Promise<string> {
  if (cachedScClientId && cachedScClientId.expiresAt > Date.now()) {
    return cachedScClientId.id;
  }

  try {
    const pageRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(3500),
    });
    const html = await pageRes.text();
    const scriptUrls = [
      ...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
    ]
      .map((m) => m[1])
      .reverse()
      .slice(0, 12);

    for (let i = 0; i < scriptUrls.length; i += 4) {
      const batch = scriptUrls.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(async (scriptUrl) => {
          try {
            const jsRes = await fetch(scriptUrl, { signal: AbortSignal.timeout(2500) });
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
  } catch {}

  return 'iZIs9schVcX5lhOfkWznGGPLICJaEMpy';
}

function isSafariCompatibleTranscoding(t: any): boolean {
  if (!t?.url || typeof t.url !== 'string') return false;
  if (t.snipped === true) return false;
  if (t.url.includes('/preview/')) return false;
  const mime = String(t?.format?.mime_type || '').toLowerCase();
  if (mime.includes('ogg') || mime.includes('opus')) return false;
  return mime.includes('mpeg') || mime.includes('mp4') || mime.includes('aac') || mime === '';
}

async function searchSoundCloudRaw(query: string, clientId: string): Promise<any[]> {
  const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=50`;
  const res = await fetch(searchUrl, {
    signal: AbortSignal.timeout(3500),
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) cachedScClientId = null;
    throw new Error('SC search HTTP ' + res.status);
  }
  const data = await res.json();
  return Array.isArray(data?.collection) ? data.collection : [];
}

async function fetchOfficialArtistTracksOnSoundCloud(
  artistName: string,
  clientId: string
): Promise<any[]> {
  const cleanArtist = extractMainArtist(artistName);
  if (!cleanArtist) return [];

  try {
    const userSearchUrl = `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(cleanArtist)}&client_id=${clientId}&limit=5`;
    const res = await fetch(userSearchUrl, {
      signal: AbortSignal.timeout(2500),
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const users: any[] = Array.isArray(data?.collection) ? data.collection : [];

    const artistTokens = tokenize(cleanArtist);
    if (artistTokens.length === 0) return [];

    const matchedUsers = users
      .filter((u) => {
        const uSet = buildTokenSet(String(u?.username || ''));
        return artistTokens.every((t) => tokensMatch(t, uSet));
      })
      .sort((a, b) => {
        const aScore = (a?.verified ? 10_000_000 : 0) + Number(a?.followers_count || 0);
        const bScore = (b?.verified ? 10_000_000 : 0) + Number(b?.followers_count || 0);
        return bScore - aScore;
      });

    const topUser = matchedUsers[0];
    if (!topUser?.id) return [];

    const tracksRes = await fetch(
      `https://api-v2.soundcloud.com/users/${topUser.id}/tracks?client_id=${clientId}&limit=50`,
      {
        signal: AbortSignal.timeout(2500),
        headers: { 'User-Agent': BROWSER_UA },
      }
    );
    if (!tracksRes.ok) return [];
    const tracksData = await tracksRes.json();
    return Array.isArray(tracksData?.collection) ? tracksData.collection : [];
  } catch {
    return [];
  }
}

async function buildHlsAudioBuffer(
  m3u8Url: string,
  expectedDurationSec: number,
  hintMimeType: string
): Promise<CachedBuffer> {
  const m3u8Res = await fetch(m3u8Url, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(3500),
  });
  if (!m3u8Res.ok) {
    throw new Error('Failed to load HLS playlist');
  }

  const m3u8Text = await m3u8Res.text();
  const lines = m3u8Text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let initSegment: { url: string; range?: string } | null = null;
  const mediaSegments: { url: string; range?: string }[] = [];
  let pendingByteRange: string | undefined;
  let totalPlaylistDurationSec = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = line.slice('#EXT-X-MAP:'.length);
      const uriMatch = attrs.match(/URI="([^"]+)"/i);
      const brMatch = attrs.match(/BYTERANGE="(\d+)(?:@(\d+))?"/i);
      if (uriMatch?.[1]) {
        const resolvedUrl = new URL(uriMatch[1], m3u8Url).toString();
        let range: string | undefined;
        if (brMatch) {
          const len = Number(brMatch[1]);
          const offset = brMatch[2] ? Number(brMatch[2]) : 0;
          range = `bytes=${offset}-${offset + len - 1}`;
        }
        initSegment = { url: resolvedUrl, range };
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durStr = line.slice('#EXTINF:'.length).split(',')[0];
      const dur = parseFloat(durStr);
      if (!isNaN(dur) && dur > 0) totalPlaylistDurationSec += dur;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const brMatch = line.slice('#EXT-X-BYTERANGE:'.length).match(/^(\d+)(?:@(\d+))?$/);
      if (brMatch) {
        const len = Number(brMatch[1]);
        const offset = brMatch[2] ? Number(brMatch[2]) : 0;
        pendingByteRange = `bytes=${offset}-${offset + len - 1}`;
      }
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const resolvedSegUrl = new URL(line, m3u8Url).toString();
    mediaSegments.push({ url: resolvedSegUrl, range: pendingByteRange });
    pendingByteRange = undefined;
  }

  if (mediaSegments.length === 0) {
    throw new Error('Empty HLS segments');
  }

  if (expectedDurationSec >= 90 && totalPlaylistDurationSec > 0 && totalPlaylistDurationSec < 45) {
    throw new Error(`HLS stream is a ${Math.round(totalPlaylistDurationSec)}s snippet`);
  }

  const allParts = initSegment ? [initSegment, ...mediaSegments] : mediaSegments;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (let i = 0; i < allParts.length; i += 20) {
    const batch = allParts.slice(i, i + 20);
    const buffers = await Promise.all(
      batch.map(async (part) => {
        const headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
        if (part.range) headers['Range'] = part.range;
        const r = await fetch(part.url, { headers, signal: AbortSignal.timeout(4500) });
        if (!r.ok && r.status !== 206) throw new Error('HLS segment failed ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
      })
    );
    for (const buf of buffers) {
      chunks.push(buf);
      totalBytes += buf.byteLength;
    }
  }

  if (totalBytes < 16384) {
    throw new Error('HLS buffer too small');
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const isMp4 =
    Boolean(initSegment) ||
    hintMimeType.toLowerCase().includes('mp4') ||
    hintMimeType.toLowerCase().includes('aac') ||
    mediaSegments[0].url.includes('.mp4') ||
    mediaSegments[0].url.includes('.m4s');

  return {
    bytes: merged,
    contentType: isMp4 ? 'audio/mp4' : 'audio/mpeg',
    expiresAt: Date.now() + 1000 * 60 * 30,
  };
}

async function fetchFromSoundCloudQuery(
  rawQuery: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec: number,
  cacheKey: string
): Promise<AudioSource> {
  const clientId = await getSoundCloudClientId();

  const strippedTitle = stripFeaturingAndTags(targetTitle);
  const primaryArtist = extractMainArtist(targetArtist);
  const primaryQuery = strippedTitle
    ? `${primaryArtist} ${strippedTitle}`.trim()
    : cleanTrackQuery(rawQuery) || rawQuery;

  const [searchItems, artistCatalogItems] = await Promise.all([
    searchSoundCloudRaw(primaryQuery, clientId),
    primaryArtist
      ? fetchOfficialArtistTracksOnSoundCloud(primaryArtist, clientId)
      : Promise.resolve([]),
  ]);

  const artistCatalogIds = new Set<number>();
  for (const item of artistCatalogItems) {
    if (item?.id) artistCatalogIds.add(item.id);
  }

  const items: any[] = [];
  const seenIds = new Set<number>();
  const appendUnique = (list: any[]) => {
    for (const it of list) {
      if (it?.id && !seenIds.has(it.id)) {
        seenIds.add(it.id);
        items.push(it);
      }
    }
  };
  appendUnique(artistCatalogItems);
  appendUnique(searchItems);

  const primaryArtistTokens = tokenize(primaryArtist);

  const buildRankedList = (sourceItems: any[], maxTol?: number, maxExtraWords = 1, minScore = 260) =>
    sourceItems
      .filter((item) => {
        if (!Array.isArray(item?.media?.transcodings)) return false;
        if (item.policy === 'BLOCK' || item.policy === 'SNIP') return false;
        const dur = Number(item.duration || 0);
        const fullDur = Number(item.full_duration || dur);
        if (fullDur - dur > 5000) return false;
        if (dur < 45000) return false;
        return true;
      })
      .map((item) => {
        const durSec = (item.duration || 0) / 1000;
        const titleStr = String(item.title || '');
        const artistStr = [item.user?.username, item.publisher_metadata?.artist]
          .filter(Boolean)
          .join(' ');
        const genreStr = String(item.genre || '');
        const tagsStr = String(item.tag_list || '');
        const descStr = String(item.description || '');

        let score = scoreCandidateMatch({
          candidateTitle: titleStr,
          candidateArtist: artistStr,
          candidateGenre: genreStr,
          candidateTags: tagsStr,
          candidateDescription: descStr,
          candidateDurationSec: durSec,
          targetTitle: strippedTitle || cleanTrackQuery(targetTitle),
          targetArtist,
          fallbackQuery: primaryQuery,
          expectedDurationSec,
          maxDurationToleranceSec: maxTol,
          maxExtraWords,
        });

        if (score >= 0) {
          if (artistCatalogIds.has(item.id)) {
            score += 450;
          }

          const userTokenSet = buildTokenSet(
            `${item.user?.username || ''} ${item.publisher_metadata?.artist || ''}`
          );
          const isArtistAccount =
            primaryArtistTokens.length > 0 &&
            primaryArtistTokens.every((tok) => tokensMatch(tok, userTokenSet));

          if (isArtistAccount) score += 250;
          if (item.user?.verified) score += 150;
          if (item.publisher_metadata?.isrc || item.publisher_metadata?.release_title) score += 130;

          const plays = Number(item.playback_count || 0);
          const likes = Number(item.likes_count || item.favoritings_count || 0);
          if (plays > 0) {
            score += Math.min(280, Math.round(Math.log10(plays + 1) * 45));
          }
          if (likes > 0) {
            score += Math.min(150, Math.round(Math.log10(likes + 1) * 34));
          }

          const hasProgressive = item.media.transcodings.some(
            (t: any) => isSafariCompatibleTranscoding(t) && t?.format?.protocol === 'progressive'
          );
          if (hasProgressive) score += 30;
        }

        return { item, score };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

  let pass1 = buildRankedList(items, undefined, 1, 260);

  // Если в первых 50 результатах были только ремиксы, делаем точный добор по фразе
  if (pass1.length === 0 && primaryArtist && strippedTitle) {
    const exactPhraseQuery = `"${primaryArtist}" "${strippedTitle}"`;
    const extraItems = await searchSoundCloudRaw(exactPhraseQuery, clientId).catch(() => []);
    appendUnique(extraItems);
    pass1 = buildRankedList(items, undefined, 1, 260);
  }

  const pass1Ids = new Set(pass1.map((t) => t.id));
  const pass2 = buildRankedList(items, 22, 3, 200).filter((t) => !pass1Ids.has(t.id));
  const rankedTracks = [...pass1, ...pass2];

  for (const track of rankedTracks) {
    const compatible = track.media.transcodings.filter(isSafariCompatibleTranscoding);

    const orderedTranscodings = [
      ...compatible.filter((t: any) => t?.format?.protocol === 'progressive'),
      ...compatible.filter(
        (t: any) =>
          t?.format?.protocol === 'hls' &&
          String(t?.format?.mime_type || '').toLowerCase().includes('mpeg')
      ),
      ...compatible.filter(
        (t: any) =>
          t?.format?.protocol === 'hls' &&
          !String(t?.format?.mime_type || '').toLowerCase().includes('mpeg')
      ),
    ];

    for (const tc of orderedTranscodings) {
      try {
        const infoRes = await fetch(`${tc.url}?client_id=${clientId}`, {
          signal: AbortSignal.timeout(2500),
        });
        if (!infoRes.ok) continue;
        const info = await infoRes.json();
        if (!info?.url || info.url.includes('/preview/')) continue;

        const isHls = tc?.format?.protocol === 'hls' || info.url.includes('.m3u8');
        const hintMime = String(tc?.format?.mime_type || 'audio/mpeg');

        if (!isHls) {
          return {
            url: info.url,
            mimeType: hintMime.includes('mp4') ? 'audio/mp4' : 'audio/mpeg',
            userAgent: BROWSER_UA,
            provider: 'soundcloud',
            isHls: false,
          };
        }

        const bufKey = `${cacheKey}:sc:${track.id}:${tc.preset || 'hls'}`;
        let bufPromise = inFlightBufferPromises.get(bufKey);
        if (!bufPromise) {
          bufPromise = buildHlsAudioBuffer(info.url, expectedDurationSec, hintMime).finally(() => {
            inFlightBufferPromises.delete(bufKey);
          });
          inFlightBufferPromises.set(bufKey, bufPromise);
        }

        const built = await bufPromise;
        setBufferCache(bufKey, built);

        return {
          url: info.url,
          mimeType: built.contentType,
          userAgent: BROWSER_UA,
          provider: 'soundcloud',
          isHls: true,
          bufferKey: bufKey,
        };
      } catch {}
    }
  }

  throw new Error('No original studio stream found');
}

function serveCachedBuffer(req: NextRequest, cached: CachedBuffer, isHead: boolean): Response {
  const total = cached.bytes.byteLength;
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      const slice = cached.bytes.slice(start, end + 1);
      return new Response(isHead ? null : Buffer.from(slice), {
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

  return new Response(isHead ? null : Buffer.from(cached.bytes), {
    status: 200,
    headers: {
      'Content-Type': cached.contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
      'Cache-Control': 'private, max-age=1800',
    },
  });
}

async function resolveAudioSourceUncached(
  rawId: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec: number,
  cacheKey: string
): Promise<AudioSource> {
  let resolvedTitle = targetTitle;
  let resolvedArtist = targetArtist;

  if (rawId.startsWith('ytq:')) {
    const rawYtq = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!resolvedTitle) {
      const parts = rawYtq.split(' - ');
      if (parts.length > 1 && !DASH_RELEASE_TAG_RE.test(` - ${parts.slice(1).join(' - ')}`)) {
        resolvedArtist = parts[0].trim();
        resolvedTitle = parts.slice(1).join(' - ').trim();
      } else {
        resolvedTitle = rawYtq;
      }
    }
  }

  const strippedTitle = stripFeaturingAndTags(resolvedTitle);
  const query = strippedTitle
    ? resolvedArtist
      ? `${resolvedArtist} ${strippedTitle}`
      : strippedTitle
    : '';

  let effectiveDuration = expectedDurationSec;
  let videoId: string | null = !rawId.startsWith('ytq:') ? rawId : null;

  const [refDur, ytmHit] = await Promise.all([
    !effectiveDuration && strippedTitle
      ? lookupReferenceDurationSec(strippedTitle, resolvedArtist)
      : Promise.resolve(0),
    !videoId && query && ytBlockedUntil <= Date.now()
      ? searchYoutubeMusicSong(query, strippedTitle, resolvedArtist, effectiveDuration)
      : Promise.resolve(null),
  ]);

  if (!effectiveDuration) {
    effectiveDuration = refDur || ytmHit?.durationSec || 0;
  }
  if (!videoId && ytmHit?.videoId) {
    videoId = ytmHit.videoId;
  }

  if (videoId && ytBlockedUntil <= Date.now()) {
    try {
      const ytSource = await tryYoutubeDirect(videoId);
      streamUrlCache.set(cacheKey, {
        ...ytSource,
        expiresAt: Date.now() + 1000 * 60 * 60,
      });
      return ytSource;
    } catch {
      if (!resolvedTitle) {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(2000) }
        ).catch(() => null);
        if (oembedRes?.ok) {
          const data = await oembedRes.json();
          resolvedTitle = cleanTrackQuery(String(data?.title || ''));
          resolvedArtist = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
          if (!effectiveDuration && resolvedTitle) {
            effectiveDuration = await lookupReferenceDurationSec(resolvedTitle, resolvedArtist);
          }
        }
      }
    }
  }

  const scSource = await fetchFromSoundCloudQuery(
    query || rawId,
    resolvedTitle,
    resolvedArtist,
    effectiveDuration,
    cacheKey
  );

  streamUrlCache.set(cacheKey, {
    ...scSource,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });

  return scSource;
}

async function getAudioSource(
  rawId: string,
  targetTitle: string,
  targetArtist: string,
  expectedDurationSec: number,
  cacheKey: string
): Promise<AudioSource> {
  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.isHls || (cached.bufferKey && fullAudioBufferCache.has(cached.bufferKey))) {
      return cached;
    }
  }

  let inFlight = inFlightSourcePromises.get(cacheKey);
  if (!inFlight) {
    inFlight = resolveAudioSourceUncached(
      rawId,
      targetTitle,
      targetArtist,
      expectedDurationSec,
      cacheKey
    ).finally(() => {
      inFlightSourcePromises.delete(cacheKey);
    });
    inFlightSourcePromises.set(cacheKey, inFlight);
  }

  return inFlight;
}

async function handleStream(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  isHead: boolean
) {
  const isPrefetch = req.nextUrl.searchParams.get('prefetch') === '1';

  try {
    const { id } = await params;
    const rawId = safeDecode(id || '').trim();
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    const rawDuration = Number(req.nextUrl.searchParams.get('d') || '0') || 0;
    const expectedDurationSec = rawDuration > 10000 ? Math.round(rawDuration / 1000) : rawDuration;
    const targetTitle = safeDecode((req.nextUrl.searchParams.get('t') || '').trim());
    const targetArtist = safeDecode((req.nextUrl.searchParams.get('a') || '').trim());
    const cacheKey = `${rawId}:${targetTitle}:${targetArtist}:${expectedDurationSec}`;

    const source = await getAudioSource(
      rawId,
      targetTitle,
      targetArtist,
      expectedDurationSec,
      cacheKey
    );

    if (isPrefetch) {
      if (!source.isHls && !fullAudioBufferCache.has(cacheKey) && !inFlightBufferPromises.has(cacheKey)) {
        const p = fetch(source.url, {
          headers: { 'User-Agent': source.userAgent },
          signal: AbortSignal.timeout(5000),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error('Prefetch failed');
            const len = Number(r.headers.get('content-length') || 0);
            if (len <= 0 || len > 18 * 1024 * 1024) throw new Error('Too large');
            const entry: CachedBuffer = {
              bytes: new Uint8Array(await r.arrayBuffer()),
              contentType: r.headers.get('content-type') || source.mimeType,
              expiresAt: Date.now() + 1000 * 60 * 30,
            };
            setBufferCache(cacheKey, entry);
            return entry;
          })
          .finally(() => {
            inFlightBufferPromises.delete(cacheKey);
          });
        inFlightBufferPromises.set(cacheKey, p);
        p.catch(() => {});
      }
      return NextResponse.json({ ok: true });
    }

    const prewarmedBuf = fullAudioBufferCache.get(cacheKey);
    if (prewarmedBuf && prewarmedBuf.expiresAt > Date.now()) {
      return serveCachedBuffer(req, prewarmedBuf, isHead);
    }

    if (source.isHls && source.bufferKey) {
      const buf = fullAudioBufferCache.get(source.bufferKey);
      if (buf && buf.expiresAt > Date.now()) {
        return serveCachedBuffer(req, buf, isHead);
      }
    }

    const rangeHeader = req.headers.get('range');
    const headers: Record<string, string> = { 'User-Agent': source.userAgent };
    if (rangeHeader) headers['Range'] = rangeHeader;

    let upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers,
    }).catch(() => null);

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      streamUrlCache.delete(cacheKey);
      const retrySource = await getAudioSource(
        rawId,
        targetTitle,
        targetArtist,
        expectedDurationSec,
        cacheKey
      );
      if (retrySource.isHls && retrySource.bufferKey) {
        const buf = fullAudioBufferCache.get(retrySource.bufferKey);
        if (buf && buf.expiresAt > Date.now()) {
          return serveCachedBuffer(req, buf, isHead);
        }
      }
      upstream = await fetch(retrySource.url, {
        method: isHead ? 'HEAD' : 'GET',
        headers,
      }).catch(() => null);
    }

    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
    }

    // Если iOS запросил Range с середины трека после паузы, а CDN вернул 200 вместо 206 —
    // кэшируем в память и отдаём точный 206 Partial Content, иначе Safari откажется играть
    if (rangeHeader && upstream.status === 200 && !isHead) {
      const len = Number(upstream.headers.get('content-length') || 0);
      if (len > 0 && len <= 20 * 1024 * 1024) {
        const entry: CachedBuffer = {
          bytes: new Uint8Array(await upstream.arrayBuffer()),
          contentType: upstream.headers.get('content-type') || source.mimeType,
          expiresAt: Date.now() + 1000 * 60 * 30,
        };
        setBufferCache(cacheKey, entry);
        return serveCachedBuffer(req, entry, false);
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

    return new Response(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    if (isPrefetch) {
      return NextResponse.json({ ok: false });
    }
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
