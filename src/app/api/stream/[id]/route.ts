// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

type ResolvedSource =
  | { type: 'remote'; url: string; exp: number }
  | { type: 'file'; filePath: string; exp: number };

const sourceCache = new Map<string, ResolvedSource>();
const inFlight = new Map<string, Promise<ResolvedSource>>();

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

function cleanupTmpFiles() {
  try {
    const files = fs
      .readdirSync('/tmp')
      .filter((f) => f.startsWith('lw_'))
      .map((f) => {
        const full = path.join('/tmp', f);
        return { full, time: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.time - a.time);

    for (const old of files.slice(25)) {
      fs.unlinkSync(old.full);
    }
  } catch {}
}

async function getTrackQuery(videoId: string): Promise<string> {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error('Не удалось получить название трека');
  const data = await res.json();

  const cleanTitle = String(data.title || '')
    .replace(/\(official.*?\)|\[official.*?\]|\(lyrics.*?\)|\[lyrics.*?\]|\(audio.*?\)|\(video.*?\)|\(hd\)|\(4k\)|премьера трека|клип/gi, '')
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

async function tryFastCdn(query: string): Promise<string | null> {
  const endpoints = [
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=3`,
    `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const json = await res.json();
      const results = json?.data?.results || json?.results || [];

      for (const item of results) {
        const downloads = item?.downloadUrl || [];
        if (Array.isArray(downloads) && downloads.length > 0) {
          const best =
            downloads.find((d: any) => d.quality === '320kbps') ||
            downloads.find((d: any) => d.quality === '160kbps') ||
            downloads[downloads.length - 1];
          const url = best?.url || best?.link;
          if (url && url.startsWith('http')) {
            return url;
          }
        }
      }
    } catch {}
  }
  return null;
}

async function trySoundCloudDownload(videoId: string, query: string): Promise<string> {
  const existing = fs.readdirSync('/tmp').find((f) => f.startsWith(`lw_${videoId}.`) && !f.endsWith('.part'));
  if (existing) {
    const full = path.join('/tmp', existing);
    if (fs.statSync(full).size > 10000) return full;
  }

  cleanupTmpFiles();
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
  } catch {
    // yt-dlp при --max-downloads 1 завершается с кодом 101 после успешного скачивания файла
  }

  const downloaded = fs
    .readdirSync('/tmp')
    .find((f) => f.startsWith(`lw_${videoId}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

  if (!downloaded) {
    throw new Error(`Не удалось загрузить аудио для "${query}"`);
  }

  const fullPath = path.join('/tmp', downloaded);
  if (fs.statSync(fullPath).size < 10000) {
    throw new Error('Скачался пустой файл');
  }

  return fullPath;
}

async function resolveAudioSource(videoId: string): Promise<ResolvedSource> {
  const cached = sourceCache.get(videoId);
  if (cached && cached.exp > Date.now()) {
    if (cached.type === 'remote' || fs.existsSync(cached.filePath)) {
      return cached;
    }
  }

  if (inFlight.has(videoId)) return inFlight.get(videoId)!;

  const task = (async (): Promise<ResolvedSource> => {
    const query = await getTrackQuery(videoId);
    console.log(`[STREAM] Поиск потока для "${query}"...`);

    const cdnUrl = await tryFastCdn(query);
    if (cdnUrl) {
      console.log(`[STREAM] Найден студийный поток для "${query}"`);
      const src: ResolvedSource = { type: 'remote', url: cdnUrl, exp: Date.now() + 3 * 3600 * 1000 };
      sourceCache.set(videoId, src);
      return src;
    }

    const filePath = await trySoundCloudDownload(videoId, query);
    console.log(`[STREAM] Загружен файл SoundCloud для "${query}"`);
    const src: ResolvedSource = { type: 'file', filePath, exp: Date.now() + 2 * 3600 * 1000 };
    sourceCache.set(videoId, src);
    return src;
  })().finally(() => inFlight.delete(videoId));

  inFlight.set(videoId, task);
  return task;
}

function serveLocalFile(req: NextRequest, filePath: string) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.m4a' || ext === '.mp4' ? 'audio/mp4' : ext === '.ogg' || ext === '.opus' ? 'audio/ogg' : 'audio/mpeg';

  const range = req.headers.get('range');
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=3600');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10) || 0;
    const end = parts[1] ? Math.min(parseInt(parts[1], 10), total - 1) : total - 1;
    const chunkSize = end - start + 1;

    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(chunkSize));

    const stream = fs.createReadStream(filePath, { start, end });
    return new NextResponse(nodeStreamToWeb(stream), { status: 206, headers });
  }

  headers.set('Content-Length', String(total));
  const stream = fs.createReadStream(filePath);
  return new NextResponse(nodeStreamToWeb(stream), { status: 200, headers });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: pId } = await params;
  const id = pId || req.nextUrl.pathname.split('/').filter(Boolean).pop();
  if (!id || ['undefined', 'stream', 'search'].includes(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get('prefetch') === '1') {
    try {
      await resolveAudioSource(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const source = await resolveAudioSource(id);

    if (source.type === 'file') {
      return serveLocalFile(req, source.filePath);
    }

    const range = req.headers.get('range');
    const fetchHeaders: HeadersInit = { 'User-Agent': 'Mozilla/5.0' };
    if (range) fetchHeaders['Range'] = range;

    const audioRes = await fetch(source.url, { headers: fetchHeaders });
    if (!audioRes.ok && audioRes.status !== 206) {
      sourceCache.delete(id);
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
  } catch (err: any) {
    console.error(`[STREAM] Сбой ${id}:`, err.message);
    sourceCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}