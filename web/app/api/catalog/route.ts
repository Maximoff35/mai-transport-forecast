import { BASINS, DEMO_INPUT, defaultInput } from '@/lib/contracts';
import { json } from '@/lib/http';

export async function GET(): Promise<Response> {
  return json({ basins: BASINS, defaults: defaultInput(), demonstration: DEMO_INPUT, unit: 'млн т/квартал' });
}
