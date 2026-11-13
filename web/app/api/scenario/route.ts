import { calculateScenario, validateInput } from '@/lib/engine';
import { VERIFIED_DATASET } from '@/lib/seed';
import { apiError, json, readJson } from '@/lib/http';
import { validateUploadedDataset } from '@/lib/csv';

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await readJson(request, 2_097_152);
    const input = validateInput(raw);
    const uploaded = (raw as Record<string, unknown>)?.dataset;
    const dataset = uploaded === undefined ? VERIFIED_DATASET : validateUploadedDataset(uploaded);
    return json({ ...calculateScenario(dataset, input), calculatedAt: new Date().toISOString() });
  } catch (error) { return apiError(error); }
}
