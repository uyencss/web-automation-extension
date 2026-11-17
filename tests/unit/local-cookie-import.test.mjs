import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseImportArgs,
  computeCookieUrl,
  handleImport,
  importCookies,
} from '../../lib/cli/commands/cookies-import.mjs';

import {
  runCookies,
  ERROR_MESSAGES,
} from '../../lib/cli/commands/cookies.mjs';

test('parseImportArgs: parses all flags and syntax variants', () => {
  const parsed1 = parseImportArgs([
    '--profile', 'Chrome:Default',
    '--input', './storage.json',
    '--domain', 'github.com',
    '--overwrite',
    '--dry-run',
    '--json',
  ]);

  assert.equal(parsed1.profileId, 'Chrome:Default');
  assert.equal(parsed1.input, './storage.json');
  assert.equal(parsed1.domain, 'github.com');
  assert.equal(parsed1.overwrite, true);
  assert.equal(parsed1.dryRun, true);
  assert.equal(parsed1.json, true);

  // Short flags and --flag=value
  const parsed2 = parseImportArgs([
    '-p', 'test-prof',
    '-i', 'input.json',
    '-d', 'example.org',
    '-h',
  ]);
  assert.equal(parsed2.profileId, 'test-prof');
  assert.equal(parsed2.input, 'input.json');
  assert.equal(parsed2.domain, 'example.org');
  assert.equal(parsed2.help, true);

  const parsed3 = parseImportArgs([
    '--profile-id=Profile 2',
    '--input=stdin.json',
    '--domain=api.sub.com',
  ]);
  assert.equal(parsed3.profileId, 'Profile 2');
  assert.equal(parsed3.input, 'stdin.json');
  assert.equal(parsed3.domain, 'api.sub.com');
});

test('computeCookieUrl: canonicalizes cookie URL for CDP', () => {
  // Secure domain cookie
  const url1 = computeCookieUrl({
    domain: '.github.com',
    path: '/',
    secure: true,
  });
  assert.equal(url1, 'https://github.com/');

  // Insecure host-only with subpath
  const url2 = computeCookieUrl({
    domain: 'localhost',
    path: '/api/v1',
    secure: false,
  });
  assert.equal(url2, 'http://localhost/api/v1');

  // Relative path without leading slash
  const url3 = computeCookieUrl({
    domain: 'example.com',
    path: 'dashboard',
    secure: true,
  });
  assert.equal(url3, 'https://example.com/dashboard');

  // Pre-existing explicit url
  const url4 = computeCookieUrl({
    url: 'https://custom.host:8443/login',
    domain: 'custom.host',
  });
  assert.equal(url4, 'https://custom.host:8443/login');
});

test('import: imports cookies from Playwright storageState JSON file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-import-test-'));
  const filePath = path.join(tmpDir, 'state.json');

  const storageState = {
    cookies: [
      {
        name: 'session_token',
        value: 'tok_12345',
        domain: '.douyin.com',
        path: '/',
        expires: 1770000000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'user_pref',
        value: 'dark_mode',
        domain: 'douyin.com',
        path: '/feed',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'None',
      },
    ],
    origins: [],
  };
  fs.writeFileSync(filePath, JSON.stringify(storageState), 'utf8');

  const setCalls = [];
  const mockGatewayCall = async (method, params, profileId) => {
    if (method === 'getCookies') {
      return {
        supportsCdpCookieAttributes: true,
        cookies: [], // No existing cookies
      };
    }
    if (method === 'setCookie') {
      setCalls.push({ params, profileId });
      return { success: true };
    }
    throw new Error(`Unexpected gateway method: ${method}`);
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: filePath },
    { gatewayCall: mockGatewayCall }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.selectedCount, 2);
  assert.equal(result.appliedCount, 2);
  assert.equal(setCalls.length, 2);

  assert.deepEqual(setCalls[0].params, {
    name: 'session_token',
    value: 'tok_12345',
    url: 'https://douyin.com/',
    path: '/',
    secure: true,
    httpOnly: true,
    domain: '.douyin.com',
    sameSite: 'Lax',
    expires: 1770000000,
  });

  // Session cookie with host-only domain (no leading dot): domain omitted, expires omitted
  assert.deepEqual(setCalls[1].params, {
    name: 'user_pref',
    value: 'dark_mode',
    url: 'https://douyin.com/feed',
    path: '/feed',
    secure: true,
    httpOnly: false,
    sameSite: 'None',
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('import: imports cookies from standard JSON array', async () => {
  const cookiesArray = [
    {
      name: 'auth_jwt',
      value: 'jwt.sample.token',
      domain: '.tiktok.com',
      path: '/',
      secure: true,
      httpOnly: true,
    },
  ];

  const setCalls = [];
  const mockGatewayCall = async (method, params) => {
    if (method === 'getCookies') {
      return { supportsCdpCookieAttributes: true, cookies: [] };
    }
    if (method === 'setCookie') {
      setCalls.push(params);
      return { success: true };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: 'mock.json' },
    {
      gatewayCall: mockGatewayCall,
      inputContent: JSON.stringify(cookiesArray),
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.appliedCount, 1);
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].name, 'auth_jwt');
});

test('import: reads from stdin when input is "-"', async () => {
  const storageState = {
    cookies: [
      {
        name: 'stdin_cookie',
        value: 'from_stdin',
        domain: '.stdin.test',
        path: '/',
        secure: true,
        httpOnly: false,
      },
    ],
  };

  const setCalls = [];
  const mockGatewayCall = async (method, params) => {
    if (method === 'getCookies') return { supportsCdpCookieAttributes: true, cookies: [] };
    if (method === 'setCookie') {
      setCalls.push(params);
      return { success: true };
    }
  };

  const mockFs = {
    readFileSync(fd, encoding) {
      if (fd === 0) {
        return JSON.stringify(storageState);
      }
      throw new Error(`Unexpected fd: ${fd}`);
    },
    existsSync() {
      return true;
    },
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: '-' },
    { gatewayCall: mockGatewayCall, fs: mockFs }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.appliedCount, 1);
  assert.equal(setCalls[0].name, 'stdin_cookie');
  assert.equal(setCalls[0].value, 'from_stdin');
});

test('import: filters cookies by --domain', async () => {
  const allCookies = [
    { name: 'c1', value: 'v1', domain: '.douyin.com', path: '/' },
    { name: 'c2', value: 'v2', domain: 'sub.douyin.com', path: '/' },
    { name: 'c3', value: 'v3', domain: '.tiktok.com', path: '/' },
    { name: 'c4', value: 'v4', domain: '.unrelated.com', path: '/' },
  ];

  const setCalls = [];
  const mockGatewayCall = async (method, params) => {
    if (method === 'getCookies') return { supportsCdpCookieAttributes: true, cookies: [] };
    if (method === 'setCookie') {
      setCalls.push(params);
      return { success: true };
    }
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: 'dummy.json', domain: 'douyin.com' },
    { gatewayCall: mockGatewayCall, inputContent: JSON.stringify(allCookies) }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.selectedCount, 2);
  assert.equal(result.appliedCount, 2);
  assert.deepEqual(setCalls.map((c) => c.name), ['c1', 'c2']);
});

test('safety: collision detection fails before mutation when cookie exists on target', async () => {
  const candidateCookies = [
    { name: 'existing_token', value: 'new_value', domain: '.example.com', path: '/' },
  ];

  const targetExistingCookies = [
    { name: 'existing_token', value: 'old_value', domain: '.example.com', path: '/' },
  ];

  let setCookieCalled = false;
  const mockGatewayCall = async (method) => {
    if (method === 'getCookies') {
      return {
        supportsCdpCookieAttributes: true,
        cookies: targetExistingCookies,
      };
    }
    if (method === 'setCookie') {
      setCookieCalled = true;
      return { success: true };
    }
  };

  await assert.rejects(
    async () => {
      await handleImport(
        { profileId: 'target-prof', input: 'dummy.json', overwrite: false },
        { gatewayCall: mockGatewayCall, inputContent: JSON.stringify(candidateCookies) }
      );
    },
    (err) => {
      assert.equal(err.code, 'COLLISION_DETECTED');
      assert.match(err.message, /COLLISION_DETECTED: Cookie 'existing_token' already exists/);
      return true;
    }
  );

  assert.equal(setCookieCalled, false, 'Mutation must not occur when collision is detected');
});

test('safety: --overwrite bypasses collision check and mutates target', async () => {
  const candidateCookies = [
    { name: 'existing_token', value: 'new_value', domain: '.example.com', path: '/' },
  ];

  let getCookiesCalled = false;
  const setCalls = [];
  const mockGatewayCall = async (method, params) => {
    if (method === 'getCookies') {
      getCookiesCalled = true;
      return { supportsCdpCookieAttributes: true, cookies: [] };
    }
    if (method === 'setCookie') {
      setCalls.push(params);
      return { success: true };
    }
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: 'dummy.json', overwrite: true },
    { gatewayCall: mockGatewayCall, inputContent: JSON.stringify(candidateCookies) }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.appliedCount, 1);
  assert.equal(getCookiesCalled, false, 'Collision preflight must be bypassed when overwrite=true');
  assert.equal(setCalls[0].name, 'existing_token');
  assert.equal(setCalls[0].value, 'new_value');
});

test('dry-run: reports valid candidate count without performing mutation', async () => {
  const candidateCookies = [
    { name: 'c1', value: 'v1', domain: '.example.com', path: '/' },
    { name: 'c2', value: 'v2', domain: '.example.com', path: '/' },
  ];

  let setCookieCalled = false;
  const mockGatewayCall = async (method) => {
    if (method === 'getCookies') {
      return { supportsCdpCookieAttributes: true, cookies: [] };
    }
    if (method === 'setCookie') {
      setCookieCalled = true;
      return { success: true };
    }
  };

  const result = await handleImport(
    { profileId: 'target-prof', input: 'dummy.json', dryRun: true },
    { gatewayCall: mockGatewayCall, inputContent: JSON.stringify(candidateCookies) }
  );

  assert.equal(result.status, 'dry-run');
  assert.equal(result.selectedCount, 2);
  assert.equal(result.appliedCount, 0);
  assert.equal(setCookieCalled, false, 'Zero mutations must occur in dry-run mode');
});

test('dry-run: still enforces collision checks when overwrite is false', async () => {
  const candidateCookies = [
    { name: 'colliding', value: 'val', domain: '.example.com', path: '/' },
  ];

  const mockGatewayCall = async (method) => {
    if (method === 'getCookies') {
      return {
        supportsCdpCookieAttributes: true,
        cookies: [{ name: 'colliding', domain: '.example.com', path: '/' }],
      };
    }
  };

  await assert.rejects(
    async () => {
      await handleImport(
        { profileId: 'target-prof', input: 'dummy.json', dryRun: true, overwrite: false },
        { gatewayCall: mockGatewayCall, inputContent: JSON.stringify(candidateCookies) }
      );
    },
    (err) => {
      assert.equal(err.code, 'COLLISION_DETECTED');
      return true;
    }
  );
});

test('errors: handles missing profile, missing input, and invalid file/JSON', async () => {
  // Missing profile
  await assert.rejects(
    () => handleImport({ input: 'test.json' }),
    { code: 'MISSING_PROFILE' }
  );

  // Missing input
  await assert.rejects(
    () => handleImport({ profileId: 'target-1' }),
    { code: 'MISSING_INPUT' }
  );

  // File not found
  await assert.rejects(
    () => handleImport({ profileId: 'target-1', input: '/nonexistent/path/cookies.json' }),
    { code: 'FILE_NOT_FOUND' }
  );

  // Invalid JSON
  await assert.rejects(
    () => handleImport(
      { profileId: 'target-1', input: 'dummy.json' },
      { inputContent: 'NOT_JSON{[' }
    ),
    { code: 'INVALID_JSON' }
  );

  // Invalid cookie structure
  await assert.rejects(
    () => handleImport(
      { profileId: 'target-1', input: 'dummy.json' },
      { inputContent: JSON.stringify({ wrong: 'schema' }) }
    ),
    { code: 'INVALID_COOKIE_FORMAT' }
  );
});

test('cli: runCookies executes import subcommand and prints human output or json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-import-test-'));
  const filePath = path.join(tmpDir, 'cookies.json');
  fs.writeFileSync(filePath, JSON.stringify([
    { name: 'session', value: 'xyz', domain: '.site.com', path: '/' }
  ]));

  // Mock global fetch for gateway calls to simulate live extension
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    if (body.method === 'getCookies') {
      return new Response(JSON.stringify({
        result: { supportsCdpCookieAttributes: true, cookies: [] }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (body.method === 'setCookie') {
      return new Response(JSON.stringify({
        result: { success: true }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400 });
  };

  try {
    const stdoutLogs = [];
    const origLog = console.log;
    console.log = (...args) => stdoutLogs.push(args.join(' '));

    const code = await runCookies([
      'import',
      '--profile', 'connected-test',
      '--input', filePath,
      '--json',
    ]);

    assert.equal(code, 0);
    const jsonOutput = JSON.parse(stdoutLogs[0]);
    assert.equal(jsonOutput.status, 'success');
    assert.equal(jsonOutput.profileId, 'connected-test');
    assert.equal(jsonOutput.appliedCount, 1);

    // Verify zero plaintext secrets leaked in top-level summary
    assert.equal(jsonOutput.session, undefined);
    assert.equal(jsonOutput.value, undefined);

    stdoutLogs.length = 0;

    // Human readable output
    const codeHuman = await runCookies([
      'import',
      '--profile', 'connected-test',
      '--input', filePath,
      '--overwrite',
    ]);
    assert.equal(codeHuman, 0);
    assert.match(stdoutLogs[0], /Successfully imported 1\/1 cookies into 'connected-test'/);

    console.log = origLog;
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('import: unwraps cookies export --json envelope and auto-recovers from chrome://newtab/ EXECUTION_FAILED', async () => {
  const exportedEnvelope = {
    status: 'success',
    profileId: 'managed:hieu2906090001',
    format: 'playwright',
    exportedCount: 1,
    data: {
      cookies: [
        { name: 'c_user', value: '10001', domain: '.facebook.com', path: '/', secure: true, httpOnly: true },
      ],
      origins: [],
    },
  };

  const calls = [];
  let hasAttachableTab = false;
  const mockGatewayCall = async (method, params, profileId) => {
    calls.push({ method, params, profileId });
    if (method === 'newTab') {
      hasAttachableTab = true;
      return { tabId: 99, url: params.url };
    }
    if (method === 'setCookie') {
      if (!hasAttachableTab) {
        const err = new Error('EXECUTION_FAILED');
        err.status = 500;
        err.payload = { error: 'EXECUTION_FAILED', extensionError: 'Cannot access a chrome:// URL' };
        throw err;
      }
      return { success: true };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await handleImport(
    { profileId: 'managed:hieu2906090001', input: 'dummy.json', overwrite: true },
    {
      gatewayCall: mockGatewayCall,
      healthLookup: async () => ({
        ok: true,
        profileDetails: [
          { profileId: '927c8935-50df-4054-9391-46924edb564c', name: 'hieu2906090001', email: '' },
        ],
      }),
      inputContent: JSON.stringify(exportedEnvelope),
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.profileId, 'managed:hieu2906090001');
  assert.equal(result.resolvedProfileId, '927c8935-50df-4054-9391-46924edb564c');
  assert.equal(result.selectedCount, 1);
  assert.equal(result.appliedCount, 1);
  assert.deepEqual(
    calls.map((c) => `${c.method}:${c.profileId}`),
    [
      'setCookie:927c8935-50df-4054-9391-46924edb564c',
      'newTab:927c8935-50df-4054-9391-46924edb564c',
      'setCookie:927c8935-50df-4054-9391-46924edb564c',
    ]
  );
});

test('import: also unwraps standard format { status, data: [...] } envelope', async () => {
  const standardEnvelope = {
    status: 'success',
    format: 'standard',
    exportedCount: 1,
    data: [{ name: 'xs', value: 'abc', domain: '.facebook.com', path: '/', secure: true }],
  };

  const setCalls = [];
  const res = await handleImport(
    { profileId: 'target-prof', input: 'dummy.json', overwrite: true },
    {
      gatewayCall: async (method, params) => {
        if (method === 'setCookie') setCalls.push(params);
        return { success: true };
      },
      inputContent: JSON.stringify(standardEnvelope),
    }
  );

  assert.equal(res.status, 'success');
  assert.equal(res.appliedCount, 1);
  assert.equal(setCalls[0].name, 'xs');
});

test('import: enforces __Host-* invariants, hostOnly domain omission, partitionKey, and continues loop on partial failures', async () => {
  const cookies = [
    {
      name: '__Host-1PLSID',
      value: 'host_val',
      domain: '.accounts.google.com',
      path: '/sub',
      secure: false,
      httpOnly: true,
      partitionKey: { topLevelSite: 'https://google.com', hasCrossSiteAncestor: false },
    },
    {
      name: 'bad_cookie',
      value: 'v_bad',
      domain: '.example.com',
      path: '/',
    },
    {
      name: 'host_only_cookie',
      value: 'v_host',
      domain: 'sub.example.com',
      url: 'https://other.host/old',
      path: '/app',
      secure: true,
    },
  ];

  const setCalls = [];
  const res = await handleImport(
    { profileId: 'target-prof', input: 'dummy.json', overwrite: true },
    {
      gatewayCall: async (method, params) => {
        if (method === 'setCookie') {
          setCalls.push(params);
          if (params.name === 'bad_cookie') return { success: false };
          return { success: true };
        }
        return {};
      },
      inputContent: JSON.stringify(cookies),
    }
  );

  assert.equal(setCalls.length, 3, 'Loop must continue past rejected cookie');
  assert.equal(res.status, 'partial');
  assert.equal(res.selectedCount, 3);
  assert.equal(res.appliedCount, 2);
  assert.equal(res.failedCount, 1);
  assert.equal(res.error, 'SET_COOKIE_REJECTED');

  // __Host-1PLSID invariants
  assert.equal(setCalls[0].domain, undefined);
  assert.equal(setCalls[0].path, '/');
  assert.equal(setCalls[0].secure, true);
  assert.equal(setCalls[0].url, 'https://accounts.google.com/');
  assert.deepEqual(setCalls[0].partitionKey, { topLevelSite: 'https://google.com', hasCrossSiteAncestor: false });

  // Non-__Host- hostOnly invariants
  assert.equal(setCalls[2].domain, undefined);
  assert.equal(setCalls[2].url, 'https://sub.example.com/app');
});

test('import: --clear-first invokes executeCDP Network.clearBrowserCookies before setCookie unless --domain or --dry-run', async () => {
  const parsedWithFlag = parseImportArgs(['--profile-id', 'p1', '-i', '-', '--clear-first']);
  assert.equal(parsedWithFlag.profileId, 'p1');
  assert.equal(parsedWithFlag.input, '-');
  assert.equal(parsedWithFlag.clearFirst, true);

  const parsedDefault = parseImportArgs(['--profile-id', 'p1', '-i', '-']);
  assert.equal(parsedDefault.clearFirst, false);

  const stdinCookies = [
    { name: 'sid', value: 'v1', domain: '.example.com', path: '/', secure: true },
    { name: 'other', value: 'v2', domain: '.other.org', path: '/', secure: true },
  ];
  const mockFs = {
    readFileSync(fd) {
      if (fd === 0) return JSON.stringify(stdinCookies);
      throw new Error(`Unexpected fd: ${fd}`);
    },
    existsSync() {
      return true;
    },
  };

  // 1. clearFirst without domain invokes executeCDP Network.clearBrowserCookies strictly before setCookie
  const calls1 = [];
  const res1 = await handleImport(
    { profileId: 'p1', input: '-', clearFirst: true, overwrite: true },
    {
      fs: mockFs,
      gatewayCall: async (method, params) => {
        calls1.push({ method, params });
        return { success: true };
      },
    }
  );
  assert.equal(res1.status, 'success');
  assert.equal(res1.appliedCount, 2);
  assert.deepEqual(
    calls1.map((c) => c.method),
    ['executeCDP', 'setCookie', 'setCookie']
  );
  assert.deepEqual(calls1[0].params, {
    method: 'Network.clearBrowserCookies',
    params: {},
  });

  // 2. clearFirst with --domain skips Network.clearBrowserCookies
  const calls2 = [];
  const res2 = await handleImport(
    { profileId: 'p1', input: '-', clearFirst: true, overwrite: true, domain: 'example.com' },
    {
      fs: mockFs,
      gatewayCall: async (method, params) => {
        calls2.push({ method, params });
        return { success: true };
      },
    }
  );
  assert.equal(res2.status, 'success');
  assert.equal(res2.appliedCount, 1);
  assert.deepEqual(
    calls2.map((c) => c.method),
    ['setCookie']
  );

  // 3. clearFirst with --dry-run does not mutate or call executeCDP
  const calls3 = [];
  const res3 = await handleImport(
    { profileId: 'p1', input: '-', clearFirst: true, overwrite: true, dryRun: true },
    {
      fs: mockFs,
      gatewayCall: async (method, params) => {
        calls3.push({ method, params });
        return { success: true };
      },
    }
  );
  assert.equal(res3.status, 'dry-run');
  assert.equal(calls3.length, 0);
});
