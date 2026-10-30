import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import backend from './lib/local-backend.cjs';
import stack from './lib/chat-test-stack.cjs';
import {
  DEDICATED_API_URL,
  DEDICATED_PROJECT,
  LEGACY_SUITE_NAMES,
  assertDedicatedStatus,
  resolveLegacyStatus,
  runLegacyHttpSuites,
} from './test-local-backend.mjs';
import {
  SUITE_NAMES,
  legacyJourneyEnv,
  parseSuiteArg,
} from './test-chat-backend.mjs';

// Synthetic status only: these tests must never start a stack or talk to HTTP.
const dedicatedStatus = {
  API_URL: DEDICATED_API_URL,
  ANON_KEY: 'dedicated-anon-key',
  SERVICE_ROLE_KEY: 'dedicated-service-key',
  JWT_SECRET: 'dedicated-jwt-secret-with-enough-length',
};

const dedicatedWorkdir = path.join(os.tmpdir(), 'opencode', 'daily-chat-home-chat-test-fixture');

// Jest transpiles localEnv.ts to CommonJS; do the same here so `__dirname`
// resolves exactly as it does in the journey and no external process starts.
async function loadLocalEnvSource() {
  const tsEntry = path.join(backend.REPO_ROOT, 'app/node_modules/typescript/lib/typescript.js');
  const typescript = (await import(pathToFileURL(tsEntry).href)).default;
  const file = path.join(backend.REPO_ROOT, 'app/testSupport/localEnv.ts');
  const output = typescript.transpileModule(await fs.readFile(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const dirname = path.dirname(file);
  const run = new Function(
    'exports', 'require', 'module', '__dirname', '__filename', 'process', output,
  );
  run(
    module.exports,
    createRequire(pathToFileURL(file)),
    module,
    dirname,
    file,
    { env: {} },
  );
  return module.exports;
}

test('dedicated status guard accepts only the owned project, port and workdir', () => {
  const accepted = assertDedicatedStatus(dedicatedStatus, {
    workdir: dedicatedWorkdir,
    project: DEDICATED_PROJECT,
  });
  assert.equal(accepted.project, stack.PROJECT_ID);
  assert.equal(accepted.workdir, path.resolve(dedicatedWorkdir));

  const cases = [
    ['normal project', dedicatedStatus, { project: 'daily-chat' }],
    ['other project', dedicatedStatus, { project: 'something-else' }],
    ['normal gateway port', { ...dedicatedStatus, API_URL: 'http://127.0.0.1:54321' }, {}],
    ['localhost alias', { ...dedicatedStatus, API_URL: 'http://localhost:55321' }, {}],
    ['normal checkout workdir', dedicatedStatus, { workdir: backend.REPO_ROOT }],
    ['workdir inside checkout', dedicatedStatus, { workdir: path.join(backend.REPO_ROOT, 'tmp') }],
    ['missing workdir', dedicatedStatus, { workdir: '' }],
    ['missing service credential', { ...dedicatedStatus, SERVICE_ROLE_KEY: '' }, {}],
  ];
  for (const [label, status, override] of cases) {
    assert.throws(
      () => assertDedicatedStatus(status, {
        workdir: dedicatedWorkdir,
        project: DEDICATED_PROJECT,
        ...override,
      }),
      /dedicated/,
      label,
    );
  }
});

test('the legacy CLI reads the normal status only when none is injected', () => {
  let calls = 0;
  const read = () => {
    calls++;
    return { API_URL: 'http://127.0.0.1:54321', label: 'normal' };
  };
  assert.deepEqual(resolveLegacyStatus({ read }), {
    API_URL: 'http://127.0.0.1:54321',
    label: 'normal',
  });
  assert.equal(calls, 1);

  const explicit = { API_URL: DEDICATED_API_URL, label: 'dedicated' };
  assert.equal(
    resolveLegacyStatus({ status: explicit, read: () => assert.fail('must not read the normal status') }),
    explicit,
  );

  assert.equal(DEDICATED_PROJECT, 'daily-chat-home-chat-test');
  assert.equal(DEDICATED_API_URL, 'http://127.0.0.1:55321');
});

test('legacy HTTP execution refuses a missing status or unknown suite before any user work', async () => {
  await assert.rejects(runLegacyHttpSuites({}), /explicit dedicated status/);
  await assert.rejects(
    runLegacyHttpSuites({ status: dedicatedStatus, suite: 'nope' }),
    /unknown suite/,
  );
  assert.deepEqual(LEGACY_SUITE_NAMES, [
    'command-boundary',
    'registration',
    'requests',
    'discovery',
    'invitations',
    'profile-publication',
    'notifications',
  ]);
});

test('--suite accepts legacy and all, rejects unknown or partial arguments', () => {
  assert.deepEqual(SUITE_NAMES, ['db', 'legacy', 'journey', 'backend']);
  for (const name of [...SUITE_NAMES, 'all']) {
    assert.equal(parseSuiteArg(['--suite', name]), name);
  }
  for (const args of [
    [],
    ['--suite'],
    ['--suite', 'nope'],
    ['legacy'],
    ['--other', 'legacy'],
    ['--suite', 'legacy', 'extra'],
  ]) {
    assert.equal(parseSuiteArg(args), null, JSON.stringify(args));
  }
});

test('the legacy journey receives only explicit dedicated configuration', () => {
  const inherited = {
    PATH: '/bin',
    HOME: '/home/test',
    EXPO_NO_DOTENV: '0',
    EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'normal-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'normal-service-key',
    LEGACY_JOURNEY_WORKDIR: backend.REPO_ROOT,
    LEGACY_JOURNEY_PROJECT: 'daily-chat',
    CHAT_JOURNEY_CONFIG: '{"normal":true}',
  };
  const env = legacyJourneyEnv({
    status: dedicatedStatus,
    workdir: dedicatedWorkdir,
    project: stack.PROJECT_ID,
  }, { env: inherited });

  assert.equal(env.EXPO_NO_DOTENV, '1');
  assert.equal(env.EXPO_PUBLIC_SUPABASE_URL, DEDICATED_API_URL);
  assert.equal(env.EXPO_PUBLIC_SUPABASE_ANON_KEY, dedicatedStatus.ANON_KEY);
  assert.equal(env.LEGACY_JOURNEY_WORKDIR, path.resolve(dedicatedWorkdir));
  assert.equal(env.LEGACY_JOURNEY_PROJECT, stack.PROJECT_ID);
  assert.equal(env.LEGACY_JOURNEY_USE_SHARED_GATEWAY, '1');
  assert.equal(env.LEGACY_JOURNEY_EXPECTED_API_URL, DEDICATED_API_URL);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.ok(!Object.keys(env).some(key => key.startsWith('SUPABASE_')));
  assert.ok(!Object.values(env).includes('normal-anon-key'));
  assert.ok(!Object.values(env).includes('normal-service-key'));
  assert.ok(!('CHAT_JOURNEY_CONFIG' in env));

  assert.throws(
    () => legacyJourneyEnv({ status: dedicatedStatus, project: stack.PROJECT_ID }, { env: inherited }),
    /workdir/,
  );
  assert.throws(
    () => legacyJourneyEnv({ status: dedicatedStatus, workdir: dedicatedWorkdir }, { env: inherited }),
    /project/,
  );
  assert.throws(
    () => legacyJourneyEnv({
      status: { ...dedicatedStatus, API_URL: 'http://127.0.0.1:54321' },
      workdir: dedicatedWorkdir,
      project: stack.PROJECT_ID,
    }, { env: inherited }),
    /dedicated API URL/,
  );
  assert.throws(
    () => legacyJourneyEnv({
      status: dedicatedStatus,
      workdir: backend.REPO_ROOT,
      project: stack.PROJECT_ID,
    }, { env: inherited }),
    /outside the normal checkout/,
  );
});

test('localEnv keeps runner values in dedicated mode and never loads app/.env', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-env-selection-'));
  const envFile = path.join(tempRoot, '.env');
  await fs.writeFile(
    envFile,
    'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nEXPO_PUBLIC_SUPABASE_ANON_KEY=file-anon-key\n',
  );
  try {
    const localEnv = await loadLocalEnvSource();
    assert.equal(typeof localEnv.loadJourneyEnv, 'function');
    assert.equal(typeof localEnv.isDedicatedJourneyEnv, 'function');

    const dedicatedEnv = {
      LEGACY_JOURNEY_WORKDIR: dedicatedWorkdir,
      EXPO_PUBLIC_SUPABASE_URL: DEDICATED_API_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'runner-anon-key',
    };
    assert.equal(localEnv.isDedicatedJourneyEnv(dedicatedEnv), true);
    assert.equal(localEnv.loadJourneyEnv(dedicatedEnv, envFile), 'dedicated');
    assert.equal(dedicatedEnv.EXPO_PUBLIC_SUPABASE_URL, DEDICATED_API_URL);
    assert.equal(dedicatedEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY, 'runner-anon-key');
    assert.deepEqual(localEnv.missingJourneyEnv(dedicatedEnv), []);

    const unflaggedDedicatedEnv = { LEGACY_JOURNEY_WORKDIR: dedicatedWorkdir };
    assert.equal(localEnv.loadJourneyEnv(unflaggedDedicatedEnv, envFile), 'dedicated');
    assert.deepEqual(localEnv.missingJourneyEnv(unflaggedDedicatedEnv), [
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    ]);

    const normalEnv = { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9999' };
    assert.equal(localEnv.isDedicatedJourneyEnv(normalEnv), false);
    assert.equal(localEnv.loadJourneyEnv(normalEnv, envFile), 'file');
    assert.equal(normalEnv.EXPO_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:54321');
    assert.equal(normalEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY, 'file-anon-key');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
