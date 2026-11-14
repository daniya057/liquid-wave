// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const metaCache: Map<string, string> = (globalThis as any).__lwMeta || new Map();
(globalThis as any).__lwMeta = metaCache;

type StreamTarget =
  | { type: 'redirect'; url: string; exp: number }
  | { type: 'file'; filePath: string; exp: number };

const sourceCache = new Map<string, StreamTarget>();
const inFlight = new Map<string, Promise<StreamTarget>>();

function getYtDlpPath(): string {
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const local = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', bin);
  return fs.existsSync(local) ? local : 'yt-dlp';
}

function nodeStreamToWeb(nodeStream: fs.ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(Buffer.from(chunk))));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

async function getTrackQuery(videoId: string): Promise<string> {
  if (metaCache.has(videoId)) return metaCache.get(videoId)!;

  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
    { signal: AbortSignal.timeout(3000) }
  );
  if (!res.ok) throw new Error('Не удалось получить название трека');
  const data = await res.json();

  const cleanTitle = String(data.title || '')
    .replace(/\(official.*?\)|\[official.*?\]|\(lyrics.*?\)|\[lyrics.*?\]|\(audio.*?\)|\(video.*?\)|\(hd\)|\(4k\)|премьера трека|клип/gi, '')
    .trim();
  const cleanAuthor = String(data.author_name || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const q = cleanAuthor && !cleanTitle.toLowerCase().includes(cleanAuthor.toLowerCase())
    ? `${cleanAuthor} - ${cleanTitle}`
    : cleanTitle;

  metaCache.set(videoId, q);
  return q;
}

// Источник 1: прямой MP4/AAC поток с CDN за ~300мс
async function raceCdn(query: string): Promise<string> {
  const res = await fetch(`https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=2`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error('CDN miss');
  const json = await res.json();
  for (const item of json?.data?.results || []) {
    const downloads = item?.downloadUrl || [];
    const best =
      downloads.find((d: any) => d.quality === '320kbps') ||
      downloads.find((d: any) => d.quality === '160kbps') ||
      downloads[downloads.length - 1];
    const url = best?.url || best?.link;
    if (url?.startsWith('http')) return url;
  }
  throw new Error('CDN empty');
}

// Источник 2: прямая MP3-ссылка с SoundCloud без скачивания файла на сервер
async function raceSoundCloudDirect(query: string): Promise<string> {
  const args = [
    '-f', 'bestaudio[protocol^=http][protocol!=m3u8][protocol!=m3u8_native]',
    '--match-filter', 'duration > 60',
    '--max-downloads', '1',
    '-g',
    '--no-warnings',
    '--no-cache-dir',
    `scsearch3:${query}`,
  ];

  let out = '';
  try {
    const { stdout } = await execFileAsync(getYtDlpPath(), args, { timeout: 10000 });
    out = stdout;
  } catch (err: any) {
    out = err?.stdout || '';
  }

  const url = out.split('\n').map((s) => s.trim()).find((s) => s.startsWith('http'));
  if (!url) throw new Error('SC direct miss');
  return url;
}

// Запасной вариант (только если трек на SoundCloud доступен исключительно в HLS)
async function fallbackSoundCloudDownload(videoId: string, query: string): Promise<string> {
  const existing = fs.readdirSync('/tmp').find((f) => f.startsWith(`lw_${videoId}.`) && !f.endsWith('.part'));
  if (existing) return path.join('/tmp', existing);

  const outTemplate = path.join('/tmp', `lw_${videoId}.%(ext)s`);
  const args = [
    '-f', 'bestaudio',
    '--fixup', 'never',
    '--match-filter', 'duration > 60',
    '--max-downloads', '1',
    '--no-warnings',
    '--no-cache-dir',
    '-o', outTemplate,
    `scsearch2:${query}`,
  ];

  try {
    await execFileAsync(getYtDlpPath(), args, { timeout: 25000 });
  } catch {}

  const downloaded = fs
    .readdirSync('/tmp')
    .find((f) => f.startsWith(`lw_${videoId}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!downloaded) throw new Error('Трек не найден');
  return path.join('/tmp', downloaded);
}

async function resolveFast(videoId: string): Promise<StreamTarget> {
  const cached = sourceCache.get(videoId);
  if (cached && cached.exp > Date.now()) {
    if (cached.type === 'redirect' || fs.existsSync(cached.filePath)) return cached;
  }
  if (inFlight.has(videoId)) return inFlight.get(videoId)!;

  const task = (async (): Promise<StreamTarget> => {
    const t0 = Date.now();
    const query = await getTrackQuery(videoId);

    try {
      // Запускаем оба быстрых источника одновременно — побеждает первый ответивший
      const directUrl = await Promise.any([raceCdn(query), raceSoundCloudDirect(query)]);
      console.log(`[STREAM] Мгновенный редирект для "${query}" за ${Date.now() - t0}ms`);
      const target: StreamTarget = { type: 'redirect', url: directUrl, exp: Date.now() + 2 * 3600 * 1000 };
      sourceCache.set(videoId, target);
      return target;
    } catch {
      const filePath = await fallbackSoundCloudDownload(videoId, query);
      console.log(`[STREAM] Фоллбэк-файл для "${query}" за ${Date.now() - t0}ms`);
      const target: StreamTarget = { type: 'file', filePath, exp: Date.now() + 2 * 3600 * 1000 };
      sourceCache.set(videoId, target);
      return target;
    }
  })().finally(() => inFlight.delete(videoId));

  inFlight.set(videoId, task);
  return task;
}

function serveLocalFile(req: NextRequest, filePath: string) {
  const total = fs.statSync(filePath).size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.m4a' || ext === '.mp4' ? 'audio/mp4' : 'audio/mpeg';

  const range = req.headers.get('range');
  const headers = new Headers({
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  });

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10) || 0;
    const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(end - start + 1));
    return new NextResponse(nodeStreamToWeb(fs.createReadStream(filePath, { start, end })), { status: 206, headers });
  }

  headers.set('Content-Length', String(total));
  return new NextResponse(nodeStreamToWeb(fs.createReadStream(filePath)), { status: 200, headers });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: pId } = await params;
  const id = pId || req.nextUrl.pathname.split('/').filter(Boolean).pop();
  if (!id || ['undefined', 'stream', 'search'].includes(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get('prefetch') === '1') {
    try {
      await resolveFast(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const target = await resolveFast(id);
    if (target.type === 'redirect') {
      return NextResponse.redirect(target.url, 302);
    }
    return serveLocalFile(req, target.filePath);
  } catch (err: any) {
    console.error(`[STREAM] Сбой ${id}:`, err.message);
    sourceCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}