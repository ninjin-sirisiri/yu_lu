import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const client = createClient(url, key);

Deno.serve(async (req: Request): Promise<Response> => {
  const body = await req.json();
  const targetKey = body.target_key as string;
  const result = await client.rpc('run_daily_cycle', { target_key: targetKey });
  if (result.error) {
    await client.from('daily_cycles').upsert({ daily_key: targetKey, draw_failed: true });
    return new Response('cycle failed', { status: 500 });
  }
  return new Response('cycle ok', { status: 200 });
});
