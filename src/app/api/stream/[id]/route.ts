import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const streamUrlCache = new Map<string, { url: string; mimeType: string; expiresAt: number }>();

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getYtDlpBinary(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const localBin = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);
  return fs.existsSync(localBin) ? localBin : binName;
}

function guessMimeType(streamUrl: string): string {
  const lower = streamUrl.toLowerCase();
  if (lower.includes('.mp3') || lower.includes('mp3')) return 'audio/mpeg';
  if (lower.includes('mime=audio%2fwebm') || lower.includes('.webm')) return 'audio/webm';
  return 'audio/mp4';
}

async function fetchViaYtDlp(target: string, isYoutube: boolean): Promise<{ url: string; mimeType: string }> {
  const bin = getYtDlpBinary();
  const args = [
    '-g',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '5',
    '-f',
    'bestaudio[protocol^=http][protocol!=m3u8_native][protocol!=m3u8]/bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio',
  ];

  if (isYoutube) {
    args.push('--extractor-args', 'youtube:player_client=tv_embedded,web_safari,android_vr');
  }

  args.push(target);

  const { stdout } = await execFileAsync(bin, args, { timeout: 9000 });
  const streamUrl = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('http'));

  if (!streamUrl) throw new Error('yt-dlp returned empty URL');
  return { url: streamUrl, mimeType: guessMimeType(streamUrl) };
}

async function fetchYoutubeTitleOEmbed(videoId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error('oEmbed failed');
    const data = await res.json();
    const title = String(data?.title || '').trim();
    const author = String(data?.author_name || '').replace(/\s*-\s*Topic$/i, '').trim();
    if (!title) throw new Error('Empty oEmbed title');
    return author && !title.toLowerCase().includes(author.toLowerCase())
      ? `${author} - ${title}`
      : title;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaSoundCloudByVideoId(videoId: string): Promise<{ url: string; mimeType: string }> {
  const title = await fetchYoutubeTitleOEmbed(videoId);
  return fetchViaYtDlp(`scsearch1:${title}`, false);
}

async function fetchInnerTubeOne(
  videoId: string,
  clientName: string,
  clientVersion: string,
  ua: string,
  extraClient: Record<string, any> = {}
): Promise<{ url: string; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ua,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName,
            clientVersion,
            hl: 'en',
            gl: 'US',
            ...extraClient,
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) throw new Error('InnerTube HTTP ' + res.status);
    const data = await res.json();
    const formats = [
      ...(data?.streamingData?.adaptiveFormats || []),
      ...(data?.streamingData?.formats || []),
    ];

    const audioFormats = formats
      .filter((f: any) => f.url && typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/'))
      .sort((a: any, b: any) => {
        const aMp4 = a.mimeType.includes('mp4') ? 1 : 0;
        const bMp4 = b.mimeType.includes('mp4') ? 1 : 0;
        if (aMp4 !== bMp4) return bMp4 - aMp4;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });

    if (!audioFormats[0]?.url) throw new Error('No audio format');
    return {
      url: audioFormats[0].url,
      mimeType: audioFormats[0].mimeType.split(';')[0] || 'audio/mp4',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getAudioSource(rawId: string): Promise<{ url: string; mimeType: string }> {
  const cached = streamUrlCache.get(rawId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType };
  }

  let resolved: { url: string; mimeType: string };

  if (rawId.startsWith('ytq:')) {
    const query = safeDecode(rawId.split(':').slice(2).join(':')).trim();
    if (!query) throw new Error('Empty track query');
    resolved = await Promise.any([
      fetchViaYtDlp(`scsearch1:${query}`, false),
      fetchViaYtDlp(`ytsearch1:${query}`, true),
    ]);
  } else {
    resolved = await Promise.any([
      fetchViaYtDlp(`https://www.youtube.com/watch?v=${rawId}`, true),
      fetchViaSoundCloudByVideoId(rawId),
      fetchInnerTubeOne(
        rawId,
        'ANDROID_VR',
        '1.60.19',
        'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        { deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 }
      ),
      fetchInnerTubeOne(
        rawId,
        'IOS',
        '19.45.4',
        'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
        { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' }
      ),
    ]);
  }

  streamUrlCache.set(rawId, {
    url: resolved.url,
    mimeType: resolved.mimeType,
    expiresAt: Date.now() + 1000 * 60 * 90,
  });

  return resolved;
}

async function handleStream(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  isHead: boolean
) {
  try {
    const { id } = await params;
    const rawId = safeDecode(id || '').trim();
    if (!rawId) {
      return NextResponse.json({ error: 'Missing track id' }, { status: 400 });
    }

    const source = await getAudioSource(rawId);

    if (req.nextUrl.searchParams.get('prefetch') === '1') {
      return NextResponse.json({ ok: true });
    }

    const rangeHeader = req.headers.get('range');
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    };
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    let upstream = await fetch(source.url, {
      method: isHead ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
    });

    if (upstream.status === 403 || upstream.status === 410) {
      streamUrlCache.delete(rawId);
      const fresh = await getAudioSource(rawId);
      upstream = await fetch(fresh.url, {
        method: isHead ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: 'Upstream stream failed' }, { status: 502 });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || source.mimeType);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'no-store');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    return new NextResponse(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to stream audio' },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleStream(req, context, false);
}

export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return handleStream(req, context, true);
}