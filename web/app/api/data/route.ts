import { VERIFIED_DATASET } from '@/lib/seed';
import { apiError, json, parseMode } from '@/lib/http';

export async function GET(request: Request): Promise<Response> {
  try { parseMode(request.url); return json(VERIFIED_DATASET); }
  catch (error) { return apiError(error); }
}
