import { validateAppearanceEnv, validateChatEnv } from '../testSupport/chatEnv';

const valid = () => ({ project: 'daily-chat-home-chat-test', url: 'http://127.0.0.1:55321',
  anonKey: 'synthetic-anon', a: { id: 'a', token: 'synthetic-a' }, b: { id: 'b', token: 'synthetic-b' } });
const validAppearance = () => ({ ...valid(), fourth: { id: 'd', token: 'synthetic-d' } });

it('fails closed for missing config, normal project/ports and remote hosts', () => {
  for (const value of [undefined, {}, { ...valid(), project: 'daily-chat' },
    { ...valid(), url: 'http://127.0.0.1:54321' }, { ...valid(), url: 'https://example.test:55321' },
    { ...valid(), anonKey: '' }, { ...valid(), a: null }]) {
    expect(() => validateChatEnv(value)).toThrow();
  }
});

it('accepts only explicit dedicated connection credentials without changing app env', () => {
  const before = { ...process.env };
  expect(validateChatEnv(valid()).url).toBe('http://127.0.0.1:55321');
  expect(process.env).toEqual(before);
});

it('appearance journey config requires the dedicated project/url and all three real actors', () => {
  expect(validateAppearanceEnv(validAppearance()).fourth.id).toBe('d');
  for (const value of [undefined, {}, valid(), { ...validAppearance(), project: 'daily-chat' },
    { ...validAppearance(), url: 'http://localhost:55321' },
    { ...validAppearance(), anonKey: '' },
    { ...validAppearance(), a: null }, { ...validAppearance(), fourth: { id: 'd', token: '' } }]) {
    expect(() => validateAppearanceEnv(value)).toThrow();
  }
});
