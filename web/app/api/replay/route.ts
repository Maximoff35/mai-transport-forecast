import { validateUploadedDataset } from '@/lib/csv';
import { apiError, json, readJson } from '@/lib/http';
import { calculateReplay, validateReplay } from '@/lib/replay';
import { VERIFIED_DATASET } from '@/lib/seed';

export async function POST(request: Request) {
  try {
    const raw = await readJson(request, 2_097_152);
    const input = validateReplay(raw);
    const uploaded = (raw as Record<string, unknown>).dataset;
    return json(calculateReplay(uploaded === undefined ? VERIFIED_DATASET : validateUploadedDataset(uploaded), input));
  } catch (error) {
    return apiError(error);
  }
}
