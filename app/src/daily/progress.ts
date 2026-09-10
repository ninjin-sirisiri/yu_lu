export type PersonProgress = {
  partnerId: string;
  sent: boolean;
  received: boolean;
  replied: boolean;
};

export function pendingPartners(rows: PersonProgress[]): string[] {
  return rows.filter((r) => r.received && !r.replied).map((r) => r.partnerId);
}
