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

// Автоматически переводит JSON-куки из расширений браузера в формат Netscape для yt-dlp
function convertJsonToNetscape(jsonStr: string): string {
  const parsed = JSON.parse(jsonStr);
  const list = Array.isArray(parsed) ? parsed : parsed.cookies || [];
  const lines = ['# Netscape HTTP Cookie File'];

  for (const c of list) {
    if (!c.domain || !c.name) continue;
    const domain = String(c.domain);
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const cookiePath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expirationDate ? Math.floor(Number(c.expirationDate)) : 0;
    const name = String(c.name);
    const value = String(c.value ?? '');

    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`);
  }

  return lines.join('\n') + '\n';
}

function getCookiesFilePath(): string | null {
  const raw = process.env.YOUTUBE_COOKIES?.trim();
  if (!raw) {
    console.warn('[STREAM] Переменная YOUTUBE_COOKIES пустая!');
    return null;
  }

  const tmpPath = path.join('/tmp', 'yt_cookies.txt');
  try {
    let content =
      raw.startsWith('#') || raw.startsWith('[') || raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf-8');

    content = content.trim();

    // Если куки в формате JSON — конвертируем в Netscape
    if (content.startsWith('[') || content.startsWith('{')) {
      content = convertJsonToNetscape(content);
    }

    fs.writeFileSync(tmpPath, content, 'utf-8');
    return tmpPath;
  } catch (e) {
    console.error('[STREAM] Ошибка обработки куки:', e);
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
    'youtube:player_client=web,mweb',
  ];

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  args.push(videoUrl);

  try {
    const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: 15000 });
    const directUrl = stdout.trim().split('\n')[0];

    if (!directUrl || !directUrl.startsWith('http')) {
      throw new Error('Пустой ответ от yt-dlp');
    }

    console.log(`[STREAM] yt-dlp получил ссылку для ${videoId} за ${Date.now() - start}ms`);
    return directUrl;
  } catch (err: any) {
    console.error(`[STREAM] Детали ошибки yt-dlp для ${videoId}:`, err.stderr || err.message);
    throw err;
  }
}

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
  } catch {
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
  const start