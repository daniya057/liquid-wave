// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';

const metaStore: Map<string, { title: string; artist: string; duration: number }> =
  (globalThis as any).__lwMetaStore || new Map();
(globalThis as any).__lwMetaStore = metaStore;

const streamCache = new Map<string, { url: string; mode: 'proxy' | 'redirect'; exp: number }>();
const inFlight = new Map<string, Promise<{ url: string; mode: 'proxy' | 'redirect' }>>();
let scClientId = { id: '', exp: 0 };

const JUNK_WORDS = ['remix', 'slowed', 'reverb', 'cover', 'karaoke', 'nightcore', '8d', 'sped up', 'instrumental', 'mashup', 'ringtone'];

function cleanTitle(str: string): string {
  return str
    .replace(/\(official.*?\)|\[official.*?\]|\(lyrics.*?\)|\[lyrics.*?\]|\(audio.*?\)|\(video.*?\)|\(hd\)|\(4k\)|премьера трека|клип/gi, '')
    .trim();
}

function tokens(str: string): string[] {
  return str.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
}

function isStrictMatch(candTitle: string, candArtist: string, candDurSec: number, orig: { title: string; artist: string; duration: number }): boolean {
  if (candDurSec > 0 && candDurSec < 45) return false;
  if (orig.duration > 0 && candDurSec > 0 && Math.abs(candDurSec - orig.duration) > 16) return false;

  const origLow = `${orig.artist} ${orig.title}`.toLowerCase();
  const candLow = `${candArtist} ${candTitle}`.toLowerCase();
  for (const bad of JUNK_WORDS) {
    if (candLow.includes(bad) && !origLow.includes(bad)) return false;
  }

  const titleWords = tokens(cleanTitle(orig.title));
  if (titleWords.length === 0) return false;
  const candSet = new Set(tokens(`${candArtist} ${candTitle}`));
  const matched = titleWords.filter((w) => candSet.has(w)).length;
  return matched / titleWords.length >= 0.6;
}

async function fetchYoutubePlayer(videoId: string, client: any) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': client.ua },
    body: JSON.stringify({ context: { client: client.ctx }, videoId }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getTrackMeta(videoId: string) {
  if (metaStore.has(videoId)) return metaStore.get(videoId)!;
  const data = await fetchYoutubePlayer(videoId, {
    ua: 'Mozilla/5.0',
    ctx: { clientName: 'WEB', clientVersion: '2.20241126.01.00' },
  });
  const details = data?.videoDetails;
  if (details?.title) {
    const meta = {
      title: String(details.title),
      artist: String(details.author || '').replace(/\s*-\s*Topic$/i, '').trim(),
      duration: Number(details.lengthSeconds) || 0,
    };
    metaStore.set(videoId, meta);
    return meta;
  }
  const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
  const o = await oembed.json();
  const meta = { title: o.title || '', artist: (o.author_name || '').replace(/\s*-\s*Topic$/i, ''), duration: 0 };
  metaStore.set(videoId, meta);
  return meta;
}

async function tryYoutubeDirect(videoId: string): Promise<string | null> {
  const clients = [
    {
      ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)',
      ctx: { clientName: 'IOS', clientVersion: '19.45.4', deviceModel: 'iPhone16,2', osName: 'iOS', osVersion: '18.1' },
    },
    {
      ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; Quest 3 Build/SQ3A.220605.009.A1)',
      ctx: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L' },
    },
  ];

  for (const c of clients) {
    try {
      const data = await fetchYoutubePlayer(videoId, c);
      const formats = data?.streamingData?.adaptiveFormats || [];
      const audio = formats
        .filter((f: any) => f.mimeType?.startsWith('audio/') && f.url)
        .sort((a: any, b: any) => (a.mimeType.includes('audio/mp4') ? -1 : 1) || (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (audio?.url) {
        const probe = await fetch(audio.url, { headers: { Range: 'bytes=0-511' }, signal: AbortSignal.timeout(2500) });
        if (probe.ok || probe.status === 206) return audio.url;
      }
    } catch {}
  }
  return null;
}

async function tryVerifiedCdn(meta: { title: string; artist: string; duration: number }): Promise<string | null> {
  const q = `${meta.artist} ${cleanTitle(meta.title)}`.trim();
  try {
    const res = await fetch(`https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&limit=5`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    for (const item of json?.data?.results || []) {
      const candArtist = item?.artists?.primary?.map((a: any) => a.name).join(' ') || '';
      if (!isStrictMatch(item.name || '', candArtist, Number(item.duration) || 0, meta)) continue;
      const dl = item.downloadUrl || [];
      const best = dl.find((d: any) => d.quality === '320kbps') || dl[dl.length - 1];
      if (best?.url) return best.url;
    }
  } catch {}
  return null;
}

async function getScClientId(): Promise<string> {
  if (scClientId.id && scClientId.exp > Date.now()) return scClientId.id;
  const html = await (await fetch('https://soundcloud.com', { signal: AbortSignal.timeout(4000) })).text();
  const scripts = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g)].map((m) => m[0]).slice(-3);
  for (const sUrl of scripts.reverse()) {
    const js = await (await fetch(sUrl, { signal: AbortSignal.timeout(4000) })).text();
    const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/);
    if (m?.[1]) {
      scClientId = { id: m[1], exp: Date.now() + 12 * 3600 * 1000 };
      return m[1];
    }
  }
  throw new Error('SC client_id не найден');
}

async function tryVerifiedSoundCloud(meta: { title: string; artist: string; duration: number }): Promise<string | null> {
  try {
    const cid = await getScClientId();
    const q = `${meta.artist} - ${cleanTitle(meta.title)}`.trim();
    const res = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=10`,
      { signal: AbortSignal.timeout(4000) }
    );
    const json = await res.json();
    for (const item of json?.collection || []) {
      if (item.policy === 'SNIP') continue;
      if (!isStrictMatch(item.title || '', item.user?.username || '', Math.round((item.duration || 0) / 1000), meta)) continue;
      const prog = (item.media?.transcodings || []).find((t: any) => t.format?.protocol === 'progressive');
      if (!prog?.url) continue;
      const streamRes = await fetch(`${prog.url}?client_id=${cid}`, { signal: AbortSignal.timeout(3000) });
      const streamJson = await streamRes.json();
      if (streamJson?.url) return streamJson.url;
    }
  } catch {}
  return null;
}

async function resolveStream(videoId: string) {
  const cached = streamCache.get(videoId);
  if (cached && cached.exp > Date.now()) return cached;
  if (inFlight.has(videoId)) return inFlight.get(videoId)!;

  const task = (async () => {
    const t0 = Date.now();
    const ytUrl = await tryYoutubeDirect(videoId);
    if (ytUrl) {
      console.log(`[STREAM] YouTube оригинал ${videoId} за ${Date.now() - t0}ms`);
      const res = { url: ytUrl, mode: 'proxy' as const, exp: Date.now() + 3 * 3600 * 1000 };
      streamCache.set(videoId, res);
      return res;
    }

    const meta = await getTrackMeta(videoId);
    const [cdnUrl, scUrl] = await Promise.all([tryVerifiedCdn(meta), tryVerifiedSoundCloud(meta)]);

    if (cdnUrl) {
      console.log(`[STREAM] CDN оригинал "${meta.title}" за ${Date.now() - t0}ms`);
      const res = { url: cdnUrl, mode: 'redirect' as const, exp: Date.now() + 3 * 3600 * 1000 };
      streamCache.set(videoId, res);
      return res;
    }
    if (scUrl) {
      console.log(`[STREAM] SoundCloud оригинал "${meta.title}" за ${Date.now() - t0}ms`);
      const res = { url: scUrl, mode: 'proxy' as const, exp: Date.now() + 3600 * 1000 };
      streamCache.set(videoId, res);
      return res;
    }
    throw new Error(`Оригинал "${meta.title}" не найден`);
  })().finally(() => inFlight.delete(videoId));

  inFlight.set(videoId, task);
  return task;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: pId } = await params;
  const id = pId || req.nextUrl.pathname.split('/').filter(Boolean).pop();
  if (!id || ['undefined', 'stream', 'search'].includes(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get('prefetch') === '1') {
    try {
      await resolveStream(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const target = await resolveStream(id);
    if (target.mode === 'redirect') return NextResponse.redirect(target.url, 302);

    const range = req.headers.get('range');
    const headersIn: HeadersInit = { 'User-Agent': 'Mozilla/5.0' };
    if (range) headersIn['Range'] = range;

    const audioRes = await fetch(target.url, { headers: headersIn });
    if (!audioRes.ok && audioRes.status !== 206) {
      streamCache.delete(id);
      return NextResponse.json({ error: 'Stream unavailable' }, { status: 502 });
    }

    const headers = new Headers({
      'Content-Type': audioRes.headers.get('content-type') || 'audio/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
    const len = audioRes.headers.get('content-length');
    const rng = audioRes.headers.get('content-range');
    if (len) headers.set('Content-Length', len);
    if (rng) headers.set('Content-Range', rng);

    return new NextResponse(audioRes.body, { status: audioRes.status, headers });
  } catch (err: any) {
    console.error(`[STREAM] Сбой ${id}:`, err.message);
    streamCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}