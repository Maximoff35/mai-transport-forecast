import { json } from '@/lib/http';

export async function GET(): Promise<Response> {
  return json({ status: 'ok', service: 'port-capacity-planner', version: '1.0.0', time: new Date().toISOString() });
}
