const slots = ['07:00', '22:00', '02:30'];

Deno.serve(async (_req: Request): Promise<Response> => {
  return new Response(JSON.stringify({ slots }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
