import { parseCsv, validateUploadedDataset } from '@/lib/csv';
import { VERIFIED_DATASET } from '@/lib/seed';
import { apiError, json, readJson, RequestError } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await readJson(request, 2_097_152) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || typeof raw.csv !== 'string') {
      throw new RequestError(422, 'VALIDATION', 'Передайте содержимое CSV в поле csv.');
    }
    const base = raw.baseDataset === undefined ? VERIFIED_DATASET : validateUploadedDataset(raw.baseDataset);
    return json(await parseCsv(raw.csv, base));
  } catch (error) { return apiError(error); }
}
