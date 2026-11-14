// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const urlCache = new Map<string, { url: string; exp: number }>();
const inFlight = new Map<string, Promise<string>>();

function getYtDlpPath(): string {
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const local = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', bin);
  return fs.existsSync(local) ? local : 'yt-dlp';
}

async function getTrackQuery(videoId: string): Promise<string> {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error('Не удалось получить название трека');
  const data = await res.json();

  const cleanTitle = String(data.title || '')
    .replace(/\(official.*?\)|\[official.*?\]|\(lyrics.*?\)|\[lyrics.*?\]|\(audio.*?\)|\(video.*?\)|\(hd\)|\(4k\)/gi, '')
    .trim();
  const cleanAuthor = String(data.author_name || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  if (!cleanTitle) return cleanAuthor;
  if (cleanAuthor && !cleanTitle.toLowerCase().includes(cleanAuthor.toLowerCase())) {
    return `${cleanAuthor} - ${cleanTitle}`;
  }
  return cleanTitle;
}

async function resolveStreamUrl(videoId: string): Promise<string> {
  const cached = urlCache.get(videoId);
  if (cached && cached.exp > Date.now()) return cached.url;
  if (inFlight.has(videoId)) return inFlight.get(videoId)!;

  const task = (async () => {
    const query = await getTrackQuery(videoId);
    console.log(`[STREAM] Ищу полную версию для "${query}"...`);

    const args = [
      '-f', 'bestaudio[protocol^=http][protocol!=m3u8][protocol!=m3u8_native]',
      '--match-filter', 'duration > 60',
      '--max-downloads', '1',
      '-g',
      '--no-warnings',
      '--no-cache-dir',
      `scsearch4:${query}`,
    ];

    let rawOut = '';
    try {
      const { stdout } = await execFileAsync(getYtDlpPath(), args, { timeout: 15000 });
      rawOut = stdout;
    } catch (err: any) {
      // yt-dlp при --max-downloads 1 завершается с кодом 101, но ссылка уже в stdout
      rawOut = err?.stdout || '';
      if (!rawOut.includes('http')) throw err;
    }

    const url = rawOut
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('http'));

    if (!url) throw new Error(`Трек "${query}" не найден`);

    urlCache.set(videoId, { url, exp: Date.now() + 2 * 3600 * 1000 });
    return url;
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
      await resolveStreamUrl(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const audioUrl = await resolveStreamUrl(id);
    const range = req.headers.get('range');
    const fetchHeaders: HeadersInit = { 'User-Agent': 'Mozilla/5.0' };
    if (range) fetchHeaders['Range'] = range;

    const audioRes = await fetch(audioUrl, { headers: fetchHeaders });
    if (!audioRes.ok && audioRes.status !== 206) {
      urlCache.delete(id);
      return NextResponse.json({ error: 'Stream unavailable' }, { status: 502 });
    }

    const headers = new Headers();
    headers.set('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');
    const len = audioRes.headers.get('content-length');
    const rng = audioRes.headers.get('content-range');
    if (len) headers.set('Content-Length', len);
    if (rng) headers.set('Content-Range', rng);

    return new NextResponse(audioRes.body, { status: audioRes.status, headers });
  } catch (err: any) {
    console.error(`[STREAM] Сбой ${id}:`, err.message);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}