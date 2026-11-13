import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const urlCache = new Map<string, { url: string; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<string>>();

function getYtDlpPath(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);
}

async function resolveWithYtDlp(videoId: string): Promise<string> {
  const ytDlpPath = getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const { stdout } = await execFileAsync(
    ytDlpPath,
    [
      '-f',
      'bestaudio[ext=m4a]/bestaudio',
      '-g',
      '--no-warnings',
      '--no-playlist',
      '--no-cache-dir',
      '--no-check-certificates',
      videoUrl,
    ],
    { timeout: 20000 }
  );

  const directUrl = stdout.trim().split('\n')[0];
  if (!directUrl || !directUrl.startsWith('http')) {
    throw new Error('Не удалось получить ссылку на аудио');
  }
  return directUrl;
}

async function getDirectAudioUrl(videoId: string): Promise<string> {
  const cached = urlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const existingPromise = inFlightRequests.get(videoId);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = resolveWithYtDlp(videoId)
    .then((url) => {
      urlCache.set(videoId, {
        url,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      inFlightRequests.delete(videoId);
      return url;
    })
    .catch((err) => {
      inFlightRequests.delete(videoId);
      throw err;
    });

  inFlightRequests.set(videoId, promise);
  return promise;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const id =
    resolvedParams?.id ||
    request.nextUrl.pathname.split('/').filter(Boolean).pop();

  if (!id || id === 'undefined' || id === 'stream' || id === 'search') {
    return NextResponse.json({ error: 'Неверный ID трека' }, { status: 400 });
  }

  if (request.nextUrl.searchParams.get('prefetch') === '1') {
    try {
      await getDirectAudioUrl(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const audioUrl = await getDirectAudioUrl(id);
    const rangeHeader = request.headers.get('range');

    const fetchHeaders: HeadersInit = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    const audioRes = await fetch(audioUrl, { headers: fetchHeaders });

    if (!audioRes.ok && audioRes.status !== 206) {
      urlCache.delete(id);
      return NextResponse.json({ error: 'Поток временно недоступен' }, { status: 502 });
    }

    const headers = new Headers();
    headers.set('Content-Type', audioRes.headers.get('content-type') || 'audio/mp4');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');

    const contentLength = audioRes.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    const contentRange = audioRes.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    return new NextResponse(audioRes.body, {
      status: audioRes.status,
      headers,
    });
  } catch (err) {
    console.error('Ошибка yt-dlp:', err);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Ошибка загрузки аудиопотока' }, { status: 502 });
  }
}