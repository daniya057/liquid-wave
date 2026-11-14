// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';

const urlCache = new Map<string, { url: string; expiresAt: number }>();

async function resolveAudiusStream(id: string): Promise<string> {
  const cached = urlCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const streamEndpoint = `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(id)}/stream?app_name=LiquidWave`;
  const res = await fetch(streamEndpoint, {
    redirect: 'manual',
    signal: AbortSignal.timeout(6000),
  });

  const finalUrl = res.headers.get('location') || streamEndpoint;
  urlCache.set(id, { url: finalUrl, expiresAt: Date.now() + 60 * 60 * 1000 });
  return finalUrl;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: pId } = await params;
  const id = pId || req.nextUrl.pathname.split('/').filter(Boolean).pop();

  if (!id || ['undefined', 'stream', 'search'].includes(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  if (req.nextUrl.searchParams.get('prefetch') === '1') {
    try {
      await resolveAudiusStream(id);
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  }

  try {
    const audioUrl = await resolveAudiusStream(id);
    const range = req.headers.get('range');
    const fetchHeaders: HeadersInit = {};
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
  } catch (err) {
    console.error(`[STREAM] Ошибка ${id}:`, err);
    urlCache.delete(id);
    return NextResponse.json({ error: 'Audio stream error' }, { status: 502 });
  }
}