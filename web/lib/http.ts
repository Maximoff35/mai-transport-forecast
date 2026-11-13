import type { ApiError } from './contracts';

export class RequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function readJson(request: Request, limit = 16_384): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new RequestError(415, 'CONTENT_TYPE', 'Передайте параметры в формате application/json.');
  }
  if (Number(request.headers.get('content-length')) > limit) {
    throw new RequestError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос. CSV и набор данных должны занимать не более 2 МБ.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'INVALID_JSON', 'Нет параметров расчёта.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > limit) {
      await reader.cancel();
      throw new RequestError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос. CSV и набор данных должны занимать не более 2 МБ.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, 'INVALID_JSON', 'Не удалось прочитать JSON с параметрами.'); }
}

export function apiError(error: unknown): Response {
  if (error instanceof RequestError) return json({ error: { code: error.code, message: error.message } } satisfies ApiError, error.status);
  const detail = error as { name?: string; message?: string; fields?: Record<string, string> };
  if (detail?.name === 'ValidationError') {
    return json({ error: { code: 'VALIDATION', message: detail.message ?? 'Проверьте параметры.', fields: detail.fields } } satisfies ApiError, 422);
  }
  console.error('API request failed', error instanceof Error ? error.name : 'Unknown error');
  return json({ error: { code: 'CALCULATION_FAILED', message: 'Расчёт временно недоступен. Повторите запрос или включите автономный режим.' } } satisfies ApiError, 503);
}

export function parseMode(url: string): 'live' | 'snapshot' {
  const mode = new URL(url).searchParams.get('mode') ?? 'snapshot';
  if (mode !== 'snapshot') throw new RequestError(422, 'VALIDATION', 'API данных возвращает исходный снимок CSV. Новые кварталы загружаются через импорт.');
  return mode;
}
