// Minimal Anthropic Messages API client (server-side only; the key never reaches the browser).

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

   const MODEL = 'claude-sonnet-5-5';
export const REREAD_MODEL = 'claude-sonnet-5-5';/** Fail fast instead of letting Supabase kill the function (which leaves the page stuck on 'extracting'). */
export const TIMEOUT_MS = Number(Deno.env.get('ANTHROPIC_TIMEOUT_MS') ?? 100_000);
export const STRICT_ID = Deno.env.get('STRICT_ID_CHECKSUM') === 'true';

export interface Img { b64: string; caption: string }

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** Detect the real image type from the first bytes (canvas.toBlob() defaults to PNG). */
export function detectMediaType(b64: string): MediaType {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/jpeg';
}

export async function callModel(system: string, images: Img[], text: string, model: string = MODEL): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        system,
        messages: [{
          role: 'user',
          content: [
            ...images.flatMap((im) => [
              { type: 'text', text: im.caption },
              { type: 'image', source: { type: 'base64', media_type: detectMediaType(im.b64), data: im.b64 } },
            ]),
            { type: 'text', text },
          ],
        }],
      }),
    });
    } catch (e) {
      lastErr = e instanceof Error && e.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS / 1000}s` : String(e);
      console.error(`[anthropic] attempt ${attempt + 1} failed: ${lastErr}`);
      break; // don't retry a timeout: the function itself would hit Supabase's wall-clock limit
    }
    if (res.ok) {
      const data = await res.json();
      const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      console.log(`[anthropic] model=${model} stop=${data.stop_reason} out_tokens=${data.usage?.output_tokens} chars=${text.length}`);
      if (!text) return `(no text; stop_reason=${data.stop_reason}; content types=${(data.content ?? []).map((c: any) => c.type).join(',')})`;
      return text;
    }
    lastErr = `${res.status} ${await res.text()}`;
    console.error(`[anthropic] attempt ${attempt + 1} failed: ${lastErr.slice(0, 500)}`);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`model call failed: ${lastErr.slice(0, 300)}`);
}
