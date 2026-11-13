import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const urlCache = new Map<string, { url: string; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<string>>();

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
];

function getYtDlpPath(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBin = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'yt-dlp';
}

// Если в Render добавлена переменная YOUTUBE_COOKIES, сохраняем её во временный файл
function getCookiesFilePath(): string | null {
  const cookiesContent = process.env.YOUTUBE_COOKIES?.trim();
  if (!cookiesContent) return null;

  const tmpPath = path.join('/tmp', 'yt_cookies.txt');
  try {
    if (!fs.existsSync(tmpPath)) {
      fs.writeFileSync(tmpPath, cookiesContent, 'utf-8');
    }
    return tmpPath;
  } catch {
    return null;
  }
}

async function resolveWithYtDlp(videoId: string): Promise<string> {
  const start = Date.now();
  const ytDlpPath = getYtDlpPath();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesPath = getCookiesFilePath();

  const args = [
    '-f',
    'bestaudio[ext=m4a]/bestaudio',
    '-g',
    '--no-warnings',
    '--no-playlist',
    '--no-cache-dir',
    '--no-check-certificates',
    '--geo-bypass',
    '--extractor-args',
    'youtube:player_client=tv_embedded,mweb,ios',
  ];

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  args.push(videoUrl);

  const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: 15000 });
  const directUrl = stdout.trim().split('\n')[0];

  if (!directUrl || !directUrl.startsWith('http')) {
    throw new Error('Не удалось получить ссылку на аудио через yt-dlp');
  }

  console.log(`[STREAM] yt-dlp получил ссылку для ${videoId} за ${Date.now() - start}ms`);
  return directUrl;
}

// Запасной вариант через зеркала, если YouTube заблокировал IP сервера Render
async function resolveWithFallbackMirrors(videoId: string): Promise<string> {
  const start = Date.now();

  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      const audioStreams: any[] = data.audioStreams || [];
      const m4a =
        audioStreams.find((s) => s.mimeType?.includes('audio/mp4')) || audioStreams[0];

      if (m4a?.url) {
        console.log(`[STREAM] Зеркало ${instance} отдало ${videoId} за ${Date.now() - start}ms`);
        return m4a.url;
      }
    } catch {
      // Пробуем следующее зеркало
    }
  }

  throw new Error('Все источники аудио временно недоступны');
}

async function resolveAudioUrl(videoId: string): Promise<string> {
  try {
    return await resolveWithYtDlp(videoId);
  } catch (err: any) {
    console.warn(`[STREAM] yt-dlp не прошёл для ${videoId}, пробую резервный канал...`);
    return await resolveWithFallbackMirrors(videoId);
  }
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

  const promise = resolveAudioUrl(videoId)
    .then((url) => {
      if (urlCache.size >= 500) {
        const firstKey = urlCache.keys().next().value;
        if (firstKey) urlCache.delete(firstKey);
      }

      urlCache.set(videoId, {
        url,
        expiresAt: Date.now() + 3 * 60 * 60 * 1000,
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
  const startTime = Date.now();
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
      console.log(`[STREAM] Prefetch готов для ${id} (${Date.now() - startTime}ms)`);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const isCached = urlCache.has(id);
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
    headers.set('Cache-Control', 'public, max-age=3600');

    const contentLength = audioRes.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    const contentRange = audioRes.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    if (!rangeHeader || rangeHeader.startsWith('bytes=0-')) {
      console.log(
        `[STREAM] Старт воспроизведения ${id} (кэш: ${isCached ? 'да' : 'нет'}) за ${Date.now() - startTime}ms`
      );
    }

    return new NextResponse(audioRes.body, {
      status: audioRes.status,
      headers,
    });
  } catch (err) {
    console.error(`[STREAM] Не удалось запустить ${id}:`, err);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Ошибка загрузки аудиопотока' }, { status: 502 });
  }
}