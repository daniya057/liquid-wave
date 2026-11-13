import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const urlCache = new Map<string, { url: string; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<string>>();

function getYtDlpPath(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBin = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);
  // Если в Docker установлен системный yt-dlp, используем его при отсутствии локального
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'yt-dlp';
}

async function resolveWithYtDlp(videoId: string): Promise<string> {
  const start = Date.now();
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
      '--geo-bypass',
      // КРИТИЧНО ДЛЯ СКОРОСТИ: обходит тяжелую JS-расшифровку на слабом CPU Render
      '--extractor-args',
      'youtube:player_client=ios,android',
      videoUrl,
    ],
    { timeout: 15000 }
  );

  const directUrl = stdout.trim().split('\n')[0];
  if (!directUrl || !directUrl.startsWith('http')) {
    throw new Error('Не удалось получить ссылку на аудио');
  }

  console.log(`[STREAM] yt-dlp получил ссылку для ${videoId} за ${Date.now() - start}ms`);
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
      // Ограничиваем размер кэша, чтобы не переполнить память на Render
      if (urlCache.size >= 500) {
        const firstKey = urlCache.keys().next().value;
        if (firstKey) urlCache.delete(firstKey);
      }

      // Ссылки YouTube живут ~5 часов, кэшируем на 3 часа
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

  // Предзагрузка следующего трека
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
        'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
    };
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    const audioRes = await fetch(audioUrl, { headers: fetchHeaders });

    if (!audioRes.ok && audioRes.status !== 206) {
      console.warn(`[STREAM] Ссылка протухла для ${id} (статус ${audioRes.status}), сбрасываю кэш`);
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
    console.error(`[STREAM] Ошибка yt-dlp для ${id}:`, err);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Ошибка загрузки аудиопотока' }, { status: 502 });
  }
}