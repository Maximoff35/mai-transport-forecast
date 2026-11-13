export async function GET(): Promise<Response> {
  const csv = 'basin,quarter,value,published_on,source_url\r\n';
  return new Response('\uFEFF' + csv, { headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="quarterly-template.csv"',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
