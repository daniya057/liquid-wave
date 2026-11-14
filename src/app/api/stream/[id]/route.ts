import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

const MIRRORS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
];

function getYtDlpPath(): string {
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const local = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', bin);
  return fs.existsSync(local) ? local : 'yt-dlp';
}

function jsonToNetscape(jsonStr: string): string {
  const parsed = JSON.parse(jsonStr);
  const list = Array.isArray(parsed) ? parsed : parsed.cookies || [];
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list) {
    if (!c.domain || !c.name) continue;
    const domain = String(c.domain);
    const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const exp = c.expirationDate ? Math.floor(Number(c.expirationDate)) : 0;
    lines.push(`${domain}\t${sub}\t${c.path || '/'}\t${secure}\t${exp}\t${c.name}\t${c.value ?? ''}`);
  }
  return lines.join('\n') + '\n';
}

function prepareCookiesText(raw: string): string {
  let text = raw.trim();
  if (!text.startsWith('#') && !text.startsWith('[') && !text.startsWith('{')) {
    text = Buffer.from(text, 'base64').toString('utf-8').trim();
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    text = jsonToNetscape(text);
  }
  return text;
}

function getCookiesFile(): string | null {
  const tmp = path.join('/tmp', 'yt_cookies.txt');
  const secretFile = '/etc/secrets/cookies.txt';

  try {
    if (fs.existsSync(secretFile)) {
      const rawFile = fs.readFileSync(secretFile, 'utf-8');
      if (rawFile.trim()) {
        fs.writeFileSync(tmp, prepareCookiesText(rawFile), 'utf-8');
        return tmp;
      }
    }

    const rawEnv = process.env.YOUTUBE_COOKIES?.trim();
    if (rawEnv) {
      fs.writeFileSync(tmp, prepareCookiesText(rawEnv), 'utf-8');
      return tmp;
    }
  } catch (e) {
    console.error('[STREAM] Ошибка чтения куки:', e);
  }
  return null;
}

async function resolveWithYtDlp(id: string): Promise<string> {
  const start = Date.now();
  const cookies = getCookiesFile();
  console.log(`[STREAM] Запуск yt-dlp для ${id} (куки: ${cookies ? 'подключены' : 'НЕТ'})`);

  const args = [
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '-g', '--no-warnings', '--no-playlist', '--no-cache-dir',
    '--no-check-certificates', '--geo-bypass',
    '--extractor-args', 'youtube:player_client=mweb,web',
  ];
  if (cookies) args.push('--cookies', cookies);
  args.push(`https://www.youtube.com/watch?v=${id}`);

  try {
    const { stdout } = await execFileAsync(getYtDlpPath(), args, { timeout: 15000 });
    const url = stdout.trim().split('\n')[0];
    if (!url?.startsWith('http')) throw new Error('Пустой ответ yt-dlp');
    console.log(`[STREAM] yt-dlp OK для ${id} за ${Date.now() - start}ms`);
    return url;
  } catch (err: any) {
    console.error(`[STREAM] Ошибка yt-dlp (${id}):`, err.stderr || err.message);
    throw err;
  }
}

async function resolveMirrors(id: string): Promise<string> {
  for (const host of MIRRORS) {
    try {
      const res = await fetch(`${host}/streams/${id}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const data = await res.json();
      const streams: any[] = data.audioStreams || [];
      const audio = streams.find((s) => s.mimeType?.includes('audio/mp4')) || streams[0];
      if (audio?.url) return audio.url;
    } catch {}
  }
  throw new Error('Все источники недоступны');
}

async function getAudioUrl(id: string): Promise<string> {
  const cached = urlCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  if (inFlight.has(id)) return inFlight.get(id)!;

  const task = resolveWithYtDlp(id)
    .catch(() => resolveMirrors(id))
    .then((url) => {
      if (urlCache.size >= 500) {
        const first = urlCache.keys().next().value;
        if (first) urlCache.delete(first);
      }
      urlCache.set(id, { url, expiresAt: Date.now() + 3 * 3600 * 1000 });
      inFlight.delete(id);
      return url;
    })
    .catch((e) => {
      inFlight.delete(id);
      throw e;
    });

  inFlight.set(id, task);
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
      await getAudioUrl(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const audioUrl = await getAudioUrl(id);
    const range = req.headers.get('range');
    const fetchHeaders: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (range) fetchHeaders['Range'] = range;

    const audioRes = await fetch(audioUrl, { headers: fetchHeaders });
    if (!audioRes.ok && audioRes.status !== 206) {
      urlCache.delete(id);
      return NextResponse.json({ error: 'Stream unavailable' }, { status: 502 });
    }

    const headers = new Headers();
    headers.set('Content-Type', audioRes.headers.get('content-type') || 'audio/mp4');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');

    const len = audioRes.headers.get('content-length');
    const rng = audioRes.headers.get('content-range');
    if (len) headers.set('Content-Length', len);
    if (rng) headers.set('Content-Range', rng);

    return new NextResponse(audioRes.body, { status: audioRes.status, headers });
  } catch (err) {
    console.error(`[STREAM] Сбой ${id}:`, err);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}