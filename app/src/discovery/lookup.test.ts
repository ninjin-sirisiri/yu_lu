import {
  appendSearchPage,
  compareSearchMatches,
  matchClass,
  normalizeSearchQuery,
  resolveSingleCandidate,
  SEARCH_PAGE_SIZE,
  PublicProfile,
} from './lookup';
import type { ProfileDetail, QueryPage } from '../backend/queries';

function profile(userIdText: string): PublicProfile {
  return {
    displayName: 'Display',
    userIdText,
    avatarPath: null,
    introduction: null,
  };
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function detail(userIdText: string, n: number): ProfileDetail {
  return {
    userId: uuid(n),
    userIdText,
    displayName: 'Display',
    avatarPath: null,
    introduction: null,
    relationship: 'none',
  };
}

describe('resolveSingleCandidate', () => {
  it('returns the single candidate with pre-request profile exposure', () => {
    const candidate = {
      displayName: 'Hanako',
      userIdText: 'hanako',
      avatarPath: '/avatars/hanako.png',
      introduction: 'Hello',
    };
    expect(resolveSingleCandidate([candidate])).toBe(candidate);
  });

  it('throws when no candidate resolves', () => {
    expect(() => resolveSingleCandidate([])).toThrow(
      'User ID input must resolve to exactly one candidate.',
    );
  });

  it('throws when two or more candidates resolve', () => {
    expect(() => resolveSingleCandidate([profile('hanako'), profile('hanako2')])).toThrow(
      'User ID input must resolve to exactly one candidate.',
    );
    expect(
      () => resolveSingleCandidate([profile('a'), profile('b'), profile('c')]),
    ).toThrow('User ID input must resolve to exactly one candidate.');
  });
});

describe('normalizeSearchQuery', () => {
  it('trims like the server and lowercases', () => {
    expect(normalizeSearchQuery('  Qorder  ')).toBe('qorder');
    expect(normalizeSearchQuery('ALICE')).toBe('alice');
  });

  it('collapses a blank query to the empty string', () => {
    expect(normalizeSearchQuery(' \t ')).toBe('');
  });
});

describe('matchClass', () => {
  it('classifies exact, prefix and substring matches', () => {
    expect(matchClass('qorder', 'qorder')).toBe('exact');
    expect(matchClass('qorder', 'qorder_1')).toBe('prefix');
    expect(matchClass('qorder', 'zqorder')).toBe('substring');
    expect(matchClass('qorder', 'other')).toBeNull();
  });

  it('matches case-insensitively in both directions', () => {
    expect(matchClass('QORDER', 'qorder')).toBe('exact');
    expect(matchClass('qorder', 'QOrderx')).toBe('prefix');
    expect(matchClass('  qorder  ', 'qorder')).toBe('exact');
  });

  it('treats underscores literally, never as LIKE wildcards', () => {
    // LIKE 'pat_tern' would also match 'patxtern'; the contract must not.
    expect(matchClass('pat_tern', 'Pat_Tern')).toBe('exact');
    expect(matchClass('pat_tern', 'patxtern')).toBeNull();
    expect(matchClass('_t', 'pat_tern')).toBe('substring');
    expect(matchClass('_t', 'patxtern')).toBeNull();
    expect(matchClass('a_c', 'abc')).toBeNull();
  });

  it('treats percent signs literally too', () => {
    expect(matchClass('100%', '100%off')).toBe('prefix');
    expect(matchClass('100%', '1005')).toBeNull();
  });

  it('never matches an empty or blank query', () => {
    expect(matchClass('', 'anything')).toBeNull();
    expect(matchClass('   ', 'anything')).toBeNull();
  });
});

describe('compareSearchMatches', () => {
  const query = 'qorder';

  it('orders exact, prefix, substring, then User ID', () => {
    const exact = detail('qorder', 1);
    const prefixedUnderscore = detail('qorder_1', 2);
    const prefixedUpper = detail('QOrderx', 3);
    const substringA = detail('aqorder', 4);
    const substringZ = detail('zqorder', 5);

    const shuffled = [substringZ, prefixedUpper, exact, substringA, prefixedUnderscore];
    const sorted = shuffled.sort((a, b) => compareSearchMatches(a, b, query));

    expect(sorted.map((p) => p.userIdText)).toEqual([
      'qorder',
      'qorder_1',
      'QOrderx',
      'aqorder',
      'zqorder',
    ]);
  });

  it('breaks ties on the internal user id', () => {
    const first = { ...detail('same', 1) };
    const second = { ...detail('same', 2) };
    expect([second, first].sort((a, b) => compareSearchMatches(a, b, 'same'))).toEqual([
      first,
      second,
    ]);
  });

  it('keeps rows that do not match after every match', () => {
    const match = detail('zqorder', 1);
    const miss = detail('unrelated', 2);
    expect(compareSearchMatches(match, miss, query)).toBeLessThan(0);
    expect(compareSearchMatches(miss, match, query)).toBeGreaterThan(0);
  });
});

describe('appendSearchPage', () => {
  const pageOf = (start: number, count: number): QueryPage<ProfileDetail> => ({
    items: Array.from({ length: count }, (_, i) =>
      detail(`pguser${String(start + i).padStart(2, '0')}`, start + i)),
    nextCursor: count === SEARCH_PAGE_SIZE ? 'next' : null,
  });

  it('holds 20 items per page', () => {
    expect(SEARCH_PAGE_SIZE).toBe(20);
    expect(pageOf(1, SEARCH_PAGE_SIZE).items).toHaveLength(20);
  });

  it('appends a 21-row result across two pages without losing order', () => {
    const page1 = pageOf(1, 20);
    const page2 = pageOf(21, 1);

    const merged = appendSearchPage(appendSearchPage([], page1), page2);

    expect(merged).toHaveLength(21);
    expect(merged[0].userIdText).toBe('pguser01');
    expect(merged[19].userIdText).toBe('pguser20');
    expect(merged[20].userIdText).toBe('pguser21');
  });

  it('never duplicates a row that appears on both pages', () => {
    const page1 = pageOf(1, 20);
    const overlap = page1.items.slice(17);
    const page2: QueryPage<ProfileDetail> = {
      items: [...overlap, detail('pguser21', 21)],
      nextCursor: null,
    };

    const merged = appendSearchPage(appendSearchPage([], page1), page2);

    expect(merged).toHaveLength(21);
    const ids = merged.map((p) => p.userId);
    expect(new Set(ids).size).toBe(21);
  });

  it('keeps server order instead of re-sorting appended rows', () => {
    const existing = [detail('zzz_last', 1)];
    const page: QueryPage<ProfileDetail> = {
      items: [detail('aaa_first', 2)],
      nextCursor: null,
    };
    expect(appendSearchPage(existing, page).map((p) => p.userIdText)).toEqual([
      'zzz_last',
      'aaa_first',
    ]);
  });

  it('does not mutate the accumulated list', () => {
    const existing = [detail('one', 1)];
    const snapshot = existing.slice();
    appendSearchPage(existing, { items: [detail('two', 2)], nextCursor: null });
    expect(existing).toEqual(snapshot);
  });
});
