export interface DailyCycleSummary {
  daily_key: string;
  processed_days: number;
  failed_days: number;
  retry_required: boolean;
}

export interface DailyCycleClient {
  rpc(name: 'advance_chat_day'): PromiseLike<{ data: unknown; error: unknown }>;
}

/** No date argument, and no raw database errors or user data in the result. */
export async function advanceChatDay(client: DailyCycleClient): Promise<DailyCycleSummary> {
  const { data, error } = await client.rpc('advance_chat_day');
  const row = data as Partial<DailyCycleSummary> | null;
  if (error || !row || typeof row.daily_key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.daily_key) ||
    !Number.isSafeInteger(row.processed_days) || (row.processed_days as number) < 0 ||
    !Number.isSafeInteger(row.failed_days) || (row.failed_days as number) < 0 || typeof row.retry_required !== 'boolean') {
    throw new Error('daily cycle unavailable');
  }
  return { daily_key: row.daily_key, processed_days: row.processed_days as number,
    failed_days: row.failed_days as number, retry_required: row.retry_required };
}
