import { createClient } from '@supabase/supabase-js';
import { advanceChatDay } from '../_shared/daily-cycle.ts';
import { handleDailySettlement } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') as string;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const client = createClient(url, key);

Deno.serve((req: Request): Promise<Response> => handleDailySettlement(req, {
  advance: () => advanceChatDay(client),
}));
