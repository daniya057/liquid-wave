// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';

const cache = new Map<string, { data: any; exp: number }>();

const DEFAULT_SUGGESTIONS = [
  'Miyagi & Эндшпиль',
  'Скриптонит',
  'Три дня дождя',
  'MACAN',
  'The Weeknd',
  'Billie Eilish',
  'Phonk',
  'Инди-рок',
  'Synthwave',
  'Lo-Fi для учёбы',
].map((s) => s.trim());

const WAVE_SEEDS = [
  'популярные новинки музыки',
  'инди рок хиты',
  'synthwave chill',
  'альтернативный рок',
  'lo-fi beats',
  'поп хиты',
  'electronic dance hits',
];

const UNWANTED_VARIANT_RE =
  /\b(remix|rmx|flip|bootleg|mashup|rework|slowed|reverb|sped\s*up|speed\s*up|nightcore|8d|bass\s*boosted|karaoke|tribute|parody|ремикс|замедл|ускор|минус|пародия)\b/i;

function parseSec(text?: string): number {
  if (!text) return 0;
  const p = text.trim().split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0;
}

function getBestThumbnail(thumbnails: any[], fallbackVideoId?: string): string {
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    const best = thumbnails[thumbnails.length - 1]?.url || thumbnails[0]?.url;
    if (best) return best.replace(/=w\d+-h\d+/, '=w544-h544');
  }
  return fallbackVideoId ? `https://i.ytimg.com/vi/${fallbackVideoId}/mqdefault.jpg` : '';
}

async function ytmRequest(endpoint: string, body: Record<string, any>, timeoutMs = 6000) {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
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
          hl: 'ru',
          gl: 'RU',
        },
      },
      ...body,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`YTM ${endpoint} HTTP ${res.status}`);
  return res.json();
}

function parseYtmTrackItem(renderer: any, forcedArtist?: string) {
  if (!renderer) return null;
  const videoId =
    renderer?.playlistItemData?.videoId ||
    renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;

  const flexCols = renderer?.flexColumns || [];
  const title =
    flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      ?.map((r: any) => r.text)
      .join('')
      .trim() || 'Без названия';

  const metaRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const metaTexts = metaRuns.map((r: any) => String(r.text || '').trim()).filter(Boolean);

  const cleanMeta = metaTexts.filter((t) => t !== '•' && t !== 'Песня' && t !== 'Song' && t !== 'Видео');
  const durationText = [...cleanMeta].reverse().find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t));
  const duration = parseSec(durationText);

  const artistCandidates = cleanMeta.filter((t) => t !== durationText && !/^\d[\d\s,.]*(тыс|млн|прослуш|views|plays)/i.test(t));
  const artist = forcedArtist || artistCandidates[0] || 'Исполнитель';
  const album = artistCandidates.length > 1 ? artistCandidates[1] : undefined;

  const thumbs =
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

  return {
    id: videoId,
    title,
    artist,
    album,
    thumbnail: getBestThumbnail(thumbs, videoId),
    duration,
  };
}

async function searchYtmFiltered(query: string, params?: string) {
  const json = await ytmRequest('search', params ? { query, params } : { query });
  const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const tracks: any[] = [];
  const albums: any[] = [];
  const artists: any[] = [];
  const seen = new Set<string>();

  for (const sec of sections) {
    const shelf = sec?.musicShelfRenderer;
    if (!shelf) continue;

    for (const item of shelf.contents || []) {
      const r = item?.musicResponsiveListItemRenderer;
      if (!r) continue;

      const navEndpoint = r?.navigationEndpoint?.browseEndpoint;
      const browseId: string = navEndpoint?.browseId || '';
      const pageType: string =
        navEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';

      const flexCols = r?.flexColumns || [];
      const mainTitle =
        flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
          ?.map((x: any) => x.text)
          .join('')
          .trim() || '';
      const subRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const subTexts = subRuns
        .map((x: any) => String(x.text || '').trim())
        .filter((t) => t && t !== '•');
      const thumbs = r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

      if (browseId.startsWith('UC') || pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
        if (browseId && !seen.has(browseId)) {
          seen.add(browseId);
          artists.push({
            id: browseId,
            browseId,
            name: mainTitle || 'Исполнитель',
            thumbnail: getBestThumbnail(thumbs),
            subscribers: subTexts.find((t) => /подписч|subscrib/i.test(t)),
          });
        }
        continue;
      }

      if (browseId.startsWith('MPREb_') || pageType === 'MUSIC_PAGE_TYPE_ALBUM') {
        if (browseId && !seen.has(browseId)) {
          seen.add(browseId);
          const artistName =
            subTexts.find((t) => !/^(альбом|сингл|ep|album|single|\d{4})$/i.test(t)) || 'Исполнитель';
          const year = subTexts.find((t) => /^\d{4}$/.test(t));
          albums.push({
            id: browseId,
            browseId,
            title: mainTitle || 'Альбом',
            artist: artistName,
            year,
            thumbnail: getBestThumbnail(thumbs),
          });
        }
        continue;
      }

      const parsedTrack = parseYtmTrackItem(r);
      if (parsedTrack && !seen.has(parsedTrack.id)) {
        seen.add(parsedTrack.id);
        tracks.push(parsedTrack);
      }
    }
  }

  return { tracks, albums, artists };
}

async function fetchPlaylistOrAlbum(rawId: string) {
  const match = rawId.match(/[?&]list=([^&]+)/);
  const cleanId = (match ? match[1] : rawId).trim();

  if (cleanId.startsWith('MPREb_')) {
    const json = await ytmRequest('browse', { browseId: cleanId });
    const header =
      json?.header?.musicResponsiveHeaderRenderer ||
      json?.header?.musicDetailHeaderRenderer;

    const title =
      header?.title?.runs?.map((r: any) => r.text).join('').trim() || 'Альбом';
    const albumArtist =
      header?.straplineTextOne?.runs?.map((r: any) => r.text).join('').trim() ||
      header?.subtitle?.runs?.find((r: any) => r.navigationEndpoint)?.text ||
      'Исполнитель';
    const headerThumbs =
      header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    const cover = getBestThumbnail(headerThumbs);

    const tracks: any[] = [];
    const seen = new Set<string>();

    const twoCol = json?.contents?.twoColumnBrowseResultsRenderer;
    const secondarySections = twoCol?.secondaryContents?.sectionListRenderer?.contents || [];
    const primarySections =
      twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ||
      json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
        ?.contents ||
      [];

    for (const sec of [...secondarySections, ...primarySections]) {
      const shelfItems =
        sec?.musicShelfRenderer?.contents || sec?.musicPlaylistShelfRenderer?.contents || [];
      for (const item of shelfItems) {
        const track = parseYtmTrackItem(item?.musicResponsiveListItemRenderer, albumArtist);
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          if (!track.thumbnail && cover) track.thumbnail = cover;
          tracks.push(track);
        }
      }
    }

    return { title, artist: albumArtist, thumbnail: cover, tracks };
  }

  const browseId = cleanId.startsWith('VL') ? cleanId : `VL${cleanId}`;
  const client = { clientName: 'WEB', clientVersion: '2.20241126.01.00', hl: 'ru', gl: 'RU' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };

  const res = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: { client }, browseId }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();

  const title =
    json?.header?.playlistHeaderRenderer?.title?.simpleText ||
    json?.metadata?.playlistMetadataRenderer?.title ||
    'Плейлист';

  const tabs = json?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const secContents =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
      ?.playlistVideoListRenderer?.contents || [];

  const tracks: any[] = [];
  const seen = new Set<string>();

  const extractItems = (items: any[]): string | null => {
    let nextToken: string | null = null;
    for (const item of items || []) {
      if (item.playlistVideoRenderer) {
        const v = item.playlistVideoRenderer;
        const id = v.videoId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const tTitle = v.title?.runs?.map((r: any) => r.text).join('') || v.title?.simpleText || 'Без названия';
        const artist = (v.shortBylineText?.runs?.[0]?.text || 'Исполнитель').replace(/\s*-\s*Topic$/i, '').trim();
        const duration = Number(v.lengthSeconds) || parseSec(v.lengthText?.simpleText);
        tracks.push({
          id,
          title: tTitle,
          artist,
          thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          duration,
        });
      } else if (item.continuationItemRenderer) {
        nextToken = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
      }
    }
    return nextToken;
  };

  let token = extractItems(secContents);
  let pages = 0;
  while (token && pages < 5) {
    pages += 1;
    const contRes = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { client }, continuation: token }),
      signal: AbortSignal.timeout(6000),
    });
    const contJson = await contRes.json();
    const contItems = contJson?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
    token = extractItems(contItems);
  }

  return { title, tracks };
}

async function fetchFullArtistCatalog(artistQueryOrId: string) {
  let browseId = artistQueryOrId.startsWith('UC') ? artistQueryOrId : '';
  let artistName = artistQueryOrId;
  let artistAvatar = '';

  if (!browseId) {
    const found = await searchYtmFiltered(artistQueryOrId, 'EgWKAQIgAWoKEAMQBBAJEAoQBQ%3D%3D');
    if (found.artists[0]) {
      browseId = found.artists[0].browseId;
      artistName = found.artists[0].name || artistName;
      artistAvatar = found.artists[0].thumbnail || '';
    }
  }

  const tracks: any[] = [];
  const albums: any[] = [];
  const seenTracks = new Set<string>();
  const seenAlbums = new Set<string>();
  let allSongsPlaylistId = '';

  if (browseId) {
    try {
      const profileJson = await ytmRequest('browse', { browseId });
      const header =
        profileJson?.header?.musicImmersiveHeaderRenderer ||
        profileJson?.header?.musicVisualHeaderRenderer ||
        profileJson?.header?.musicResponsiveHeaderRenderer;

      if (header?.title?.runs?.[0]?.text) {
        artistName = header.title.runs.map((r: any) => r.text).join('').trim();
      }
      const headerThumbs = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      if (headerThumbs.length > 0) {
        artistAvatar = getBestThumbnail(headerThumbs);
      }

      const sections =
        profileJson?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
          ?.sectionListRenderer?.contents || [];

      for (const sec of sections) {
        if (sec?.musicShelfRenderer) {
          const shelf = sec.musicShelfRenderer;
          const bottomEndpoint = shelf?.bottomEndpoint?.browseEndpoint;
          if (bottomEndpoint?.browseId) {
            allSongsPlaylistId = bottomEndpoint.browseId;
          }
          for (const item of shelf.contents || []) {
            const t = parseYtmTrackItem(item?.musicResponsiveListItemRenderer, artistName);
            if (t && !seenTracks.has(t.id)) {
              seenTracks.add(t.id);
              tracks.push(t);
            }
          }
        }

        if (sec?.musicCarouselShelfRenderer) {
          const carousel = sec.musicCarouselShelfRenderer;
          const shelfTitle =
            carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || '';
          const isSingleSection = /сингл|single/i.test(shelfTitle);

          for (const item of carousel.contents || []) {
            const twoRow = item?.musicTwoRowItemRenderer;
            if (!twoRow) continue;
            const ep = twoRow?.navigationEndpoint?.browseEndpoint;
            const bId = ep?.browseId || '';
            const pType =
              ep?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';

            if (bId.startsWith('MPREb_') || pType === 'MUSIC_PAGE_TYPE_ALBUM') {
              if (!seenAlbums.has(bId)) {
                seenAlbums.add(bId);
                const albTitle =
                  twoRow?.title?.runs?.map((r: any) => r.text).join('').trim() || 'Альбом';
                const subTexts = (twoRow?.subtitle?.runs || []).map((r: any) => r.text.trim());
                const year = subTexts.find((t: string) => /^\d{4}$/.test(t));
                const thumbs = twoRow?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

                albums.push({
                  id: bId,
                  browseId: bId,
                  title: albTitle,
                  artist: artistName,
                  year,
                  type: isSingleSection ? 'Сингл' : 'Альбом',
                  thumbnail: getBestThumbnail(thumbs),
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  if (allSongsPlaylistId) {
    try {
      const fullSongsPl = await fetchPlaylistOrAlbum(allSongsPlaylistId);
      for (const t of fullSongsPl.tracks || []) {
        if (t?.id && !seenTracks.has(t.id)) {
          seenTracks.add(t.id);
          tracks.push({ ...t, artist: artistName });
        }
      }
    } catch {}
  }

  const [moreSongs, moreAlbums] = await Promise.all([
    searchYtmFiltered(artistName, 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D').catch(() => ({ tracks: [], albums: [], artists: [] })),
    searchYtmFiltered(artistName, 'EgWKAQIYAWoKEAMQBBAJEAoQBQ%3D%3D').catch(() => ({ tracks: [], albums: [], artists: [] })),
  ]);

  const artistLower = artistName.toLowerCase();
  for (const t of moreSongs.tracks) {
    const belongsToArtist =
      t.artist.toLowerCase().includes(artistLower) || artistLower.includes(t.artist.toLowerCase());
    if (belongsToArtist && !seenTracks.has(t.id)) {
      seenTracks.add(t.id);
      tracks.push(t);
    }
  }

  for (const alb of moreAlbums.albums) {
    const belongsToArtist =
      alb.artist.toLowerCase().includes(artistLower) || artistLower.includes(alb.artist.toLowerCase());
    if (belongsToArtist && !seenAlbums.has(alb.id)) {
      seenAlbums.add(alb.id);
      albums.push(alb);
    }
  }

  return {
    artist: {
      id: browseId || artistName,
      browseId,
      name: artistName,
      thumbnail: artistAvatar || tracks[0]?.thumbnail || albums[0]?.thumbnail || '',
    },
    tracks,
    albums,
  };
}

async function fetchSearchSuggestions(q: string): Promise<string[]> {
  if (!q) {
    return DEFAULT_SUGGESTIONS;
  }

  try {
    const json = await ytmRequest('music/get_search_suggestions', { input: q }, 3000);
    const contents =
      json?.contents?.[0]?.searchSuggestionsSectionRenderer?.contents || [];
    const list: string[] = [];

    for (const item of contents) {
      const runs = item?.searchSuggestionRenderer?.suggestion?.runs || [];
      const text = runs.map((r: any) => r.text).join('').trim();
      if (text && !list.includes(text)) {
        list.push(text);
      }
    }

    return list.length > 0 ? list.slice(0, 8) : DEFAULT_SUGGESTIONS.filter((s) => s.toLowerCase().includes(q.toLowerCase()));
  } catch {
    return DEFAULT_SUGGESTIONS.filter((s) => s.toLowerCase().includes(q.toLowerCase()));
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() || '';
  const mode = searchParams.get('mode');
  const listId = searchParams.get('listId')?.trim();
  const artist = searchParams.get('artist')?.trim();

  try {
    if (mode === 'suggestions') {
      const suggestions = await fetchSearchSuggestions(q);
      return NextResponse.json({ suggestions });
    }

    if (listId) {
      const key = `pl:${listId}`;
      if (cache.get(key)?.exp > Date.now()) return NextResponse.json(cache.get(key)!.data);

      const pl = await fetchPlaylistOrAlbum(listId);
      if (pl.tracks.length > 0) {
        cache.set(key, { data: pl, exp: Date.now() + 1800000 });
      }
      return NextResponse.json(pl);
    }

    if (artist) {
      const key = `artist:${artist.toLowerCase()}`;
      if (cache.get(key)?.exp > Date.now()) return NextResponse.json(cache.get(key)!.data);

      const artistData = await fetchFullArtistCatalog(artist);
      if (artistData.tracks.length > 0 || artistData.albums.length > 0) {
        cache.set(key, { data: artistData, exp: Date.now() + 1800000 });
      }
      return NextResponse.json(artistData);
    }

    if (mode === 'wave' || !q) {
      const seed = WAVE_SEEDS[Math.floor(Math.random() * WAVE_SEEDS.length)];
      const waveRes = await searchYtmFiltered(seed, 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D');
      return NextResponse.json({
        tracks: waveRes.tracks.slice(0, 25),
        albums: [],
        artists: [],
        suggestions: DEFAULT_SUGGESTIONS,
      });
    }

    const key = `ytm-q:${q.toLowerCase()}`;
    if (cache.get(key)?.exp > Date.now()) return NextResponse.json(cache.get(key)!.data);

    const queryHasVariant = UNWANTED_VARIANT_RE.test(q);

    const [songsRes, albumsRes, artistsRes] = await Promise.all([
      searchYtmFiltered(q, 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D').catch(() => ({ tracks: [], albums: [], artists: [] })),
      searchYtmFiltered(q, 'EgWKAQIYAWoKEAMQBBAJEAoQBQ%3D%3D').catch(() => ({ tracks: [], albums: [], artists: [] })),
      searchYtmFiltered(q, 'EgWKAQIgAWoKEAMQBBAJEAoQBQ%3D%3D').catch(() => ({ tracks: [], albums: [], artists: [] })),
    ]);

    const sortedTracks = [...songsRes.tracks].sort((a, b) => {
      if (queryHasVariant) return 0;
      const aBad = UNWANTED_VARIANT_RE.test(a.title) ? 1 : 0;
      const bBad = UNWANTED_VARIANT_RE.test(b.title) ? 1 : 0;
      return aBad - bBad;
    });

    const result = {
      tracks: sortedTracks.slice(0, 25),
      albums: albumsRes.albums.slice(0, 16),
      artists: artistsRes.artists.slice(0, 10),
    };

    if (result.tracks.length || result.albums.length || result.artists.length) {
      cache.set(key, { data: result, exp: Date.now() + 1800000 });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[SEARCH] Ошибка:', err);
    return NextResponse.json({ tracks: [], albums: [], artists: [], suggestions: DEFAULT_SUGGESTIONS }, { status: 500 });
  }
}