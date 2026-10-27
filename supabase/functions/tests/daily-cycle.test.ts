import { handleDailySettlement } from '../daily-settlement/handler.ts';
import { advanceChatDay } from '../_shared/daily-cycle.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const credential = 'test-service-only';
const settled = { daily_key: '2030-01-01', processed_days: 1, failed_days: 0, retry_required: false };
const request = (body = '{}', token = credential, query = '') => new Request(`http://local/daily-settlement${query}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
});

Deno.test('service auth precedes database work; missing configuration fails closed', async () => {
  for (const req of [request('{}', 'user-token'), new Request('http://local', { method: 'POST' })]) {
    const res = await handleDailySettlement(req, { credential, advance: () => { throw new Error('must not run'); } });
    assert(res.status === 401, 'unauthorized worker call rejected');
  }
  const res = await handleDailySettlement(request(), { credential: '', advance: () => { throw new Error('must not run'); } });
  assert(res.status === 401, 'missing credential fails closed');
});

Deno.test('HTTP rejects caller dates and all nonempty payloads without running job', async () => {
  for (const [body, query] of [['{"target_key":"2030-01-01"}', ''], ['{"now":"2030-01-01"}', ''], ['{}', '?target_key=2030-01-01'], ['null', ''], ['[]', ''], ['broken', '']]) {
    const res = await handleDailySettlement(request(body, credential, query), { credential, advance: () => { throw new Error('must not run'); } });
    assert(res.status === 400, `unsafe payload rejected: ${body}${query}`);
  }
});

Deno.test('POST only, empty body allowed, duplicate invocation returns safe summary', async () => {
  const deps = { credential, advance: () => Promise.resolve(settled) };
  const get = await handleDailySettlement(new Request('http://local', { headers: { authorization: `Bearer ${credential}` } }), deps);
  assert(get.status === 405, 'GET cannot mutate');
  for (const body of ['', '{}']) {
    const res = await handleDailySettlement(request(body), deps);
    assert(res.status === 200, 'successful/repeated run accepted');
    assert(JSON.stringify(await res.json()) === JSON.stringify(settled), 'safe aggregate summary returned');
  }
});

Deno.test('retry and permanent failed-day results notify monitoring without secrets', async () => {
  for (const result of [{ ...settled, retry_required: true }, { ...settled, failed_days: 2 }]) {
    const res = await handleDailySettlement(request(), { credential, advance: () => Promise.resolve(result) });
    assert(res.status === 503, 'non-healthy lifecycle yields monitoring failure');
    assert((await res.json()).daily_key === '2030-01-01', 'nonsecret recovery date returned');
  }
  const res = await handleDailySettlement(request(), { credential, advance: () => { throw new Error('secret SQL detail'); } });
  assert(res.status === 503, 'RPC exception is retryable');
  assert(!(await res.text()).includes('secret'), 'internal exception never exposed');
});

Deno.test('RPC adapter sends no date and sanitizes errors/unexpected database fields', async () => {
  const result = await advanceChatDay({ rpc: (name: string, ...args: unknown[]) => {
    assert(name === 'advance_chat_day' && args.length === 0, 'only clock-only RPC is used');
    return Promise.resolve({ data: { ...settled, private_detail: 'never expose' }, error: null });
  } });
  assert(JSON.stringify(result) === JSON.stringify(settled), 'only allowlisted aggregate fields escape');
  for (const reply of [{ data: null, error: { message: 'private detail' } }, { data: {}, error: null }]) {
    try {
      await advanceChatDay({ rpc: () => Promise.resolve(reply) });
      throw new Error('expected failure');
    } catch (error) {
      assert(error instanceof Error && error.message === 'daily cycle unavailable', 'RPC details hidden');
    }
  }
});
