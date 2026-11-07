import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// ---------- selftest：所有派发和写入都隔离在临时目录 ----------
export async function selftest({
  SCRIPT_PATH, ROOT, CONFIG_FILE, DEFAULT_STATE_DIR, STATE_DIR,
  REPORT_FOOTER, READ_ONLY_REPORT_FOOTER, RULES, LIMIT_KEY,
  charCount, resolveDispatchContext, safeRouteContext,
}) {
  const SELFTEST_STATE_ROOT = (() => {
    const relative = path.relative(STATE_DIR, DEFAULT_STATE_DIR);
    const defaultInsideShared = !relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return defaultInsideShared ? os.tmpdir() : DEFAULT_STATE_DIR;
  })();
  delete process.env.AGENT_ROUTE_DEPTH;
  let tmpDir;
  let failed = false;
  try {
    fs.mkdirSync(SELFTEST_STATE_ROOT, { recursive: true });
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(SELFTEST_STATE_ROOT, 'agent-route-selftest-')));
    const home = path.join(tmpDir, 'home');
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    const repoAlias = path.join(tmpDir, 'repo-alias');
    fs.symlinkSync(repo, repoAlias, 'dir');
    fs.copyFileSync(CONFIG_FILE, path.join(home, 'config.json'));
    fs.copyFileSync(path.join(ROOT, 'agents.json'), path.join(home, 'agents.json'));
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    config.codexBin = path.resolve(path.dirname(SCRIPT_PATH), '../test/codex-stub');
    config.claudeBin = config.codexBin;
    config.logMode = 'summary';
    config.readOnlyExclude = [];
    config.ccSwitch = { enabled: false, deviceDir: path.join(home, '.cc-switch'),
      databasePath: path.join(home, 'cc-data', 'cc-switch.db'), onReadError: 'live-config' };
    fs.accessSync(config.codexBin, fs.constants.X_OK);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      XDG_CONFIG_HOME: path.join(home, '.config'), TMPDIR: path.join(home, 'tmp'), AGENT_ROUTE_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CEILING_DIRECTORIES: tmpDir,
      AGENT_ROUTE_FORCE_CODEX_FAIL: '0',
      AGENT_ROUTE_PROBE_JSON: JSON.stringify({ claude: config.claudeBin, codex: config.codexBin }),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    fs.writeFileSync(path.join(home, 'selftest-isolation.json'), JSON.stringify({ home, codexHome: env.CODEX_HOME, root: tmpDir }));
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'selftest-account' } }));
    const check = (ok, reason) => { if (!ok) throw new Error(reason); };
    const samePath = (a, b) => Boolean(a && b) && fs.realpathSync(a) === fs.realpathSync(b);
    const resumeCwdIs = (result, expected) => {
      const value = result.log.match(/^  - resume cwd: (.+)$/m)?.[1];
      return value && samePath(path.resolve(result.record.cwd, value), expected);
    };
    const git = (...args) => {
      const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 5000 });
      check(!result.error && result.status === 0,
        `git ${args.join(' ')}: ${result.error?.message ?? result.stderr.trim()}`);
      return result.stdout;
    };
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'selftest fixture\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\nexcluded/\n__pycache__/\n');
    git('init', '--quiet');
    git('config', 'user.name', 'agent-route selftest');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(repo, '.git', 'hooks'));
    const hookAttempts = path.join(home, 'hook-attempts.txt');
    const hookPath = path.join(repo, '.git', 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!${process.execPath}\nconst fs = require('node:fs');
const message = fs.readFileSync(process.argv[2], 'utf8').split('\\n')[0];
fs.appendFileSync(${JSON.stringify(hookAttempts)}, message + '\\n');
if (!/^(feat|fix|docs|refactor|test|build|ci|chore|perf|revert)\\([^)]+\\)!?: .+/.test(message) || message.includes('reject')) {
  console.error('selftest commit-msg rejected');
  process.exit(1);
}\n`, { mode: 0o755 });
    git('add', 'tracked.txt', '.gitignore');
    git('-c', 'user.name=agent-route selftest', '-c', 'user.email=selftest@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'chore(selftest): seed fixture');

    const historyPath = path.join(home, 'state', 'history.jsonl');
    const history = () => fs.existsSync(historyPath)
      ? fs.readFileSync(historyPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    let dispatchTimeout = 5000;
    const run = (scenario, args = [], claude = false, { inheritCwd = false, preserveCooldown = false, rounds = 1, nodeArgs = [], timeout = dispatchTimeout, tier: runTier = 'tier1' } = {}) => {
      if (!preserveCooldown) {
        fs.rmSync(path.join(home, 'state', 'cooldown.json'), { force: true });
        fs.rmSync(path.join(home, 'state', 'codex-limit.json'), { force: true });
        fs.rmSync(path.join(home, 'state', 'provider-limit.json'), { force: true });
      }
      const count = history().length;
      const input = `AGENT_ROUTE_SELFTEST:${scenario}\n任务字符计数 🧪  \n`;
      const result = spawnSync(process.execPath,
        [...nodeArgs, SCRIPT_PATH, runTier, ...(claude ? [] : ['--no-claude']), ...(inheritCwd ? [] : ['--cwd', repo]), ...args],
        { env, cwd: home, input, encoding: 'utf8', timeout });
      check(!result.error, `${scenario} ${args.join(' ')} (timeout ${timeout}ms): ${result.error?.message}`);
      const footer = result.stdout.split('\n---\n')[1] ?? '';
      const records = history();
      check(records.length === count + rounds, `每次派发应新增 ${rounds} 条 history: ${result.stdout} ${result.stderr}`);
      const record = records.at(-1);
      const outputId = footer.match(/(?:^|\| )id ([^\n|]+)/m)?.[1]?.trim() ??
        path.basename(result.stdout.match(/^log: (.+)$/m)?.[1]?.trim() ?? '', '.log');
      const logPath = path.join(home, 'logs', `${record.log_id}.log`);
      check(record.log_id === outputId && record.exit_code === result.status,
        'history 的日志 id 或退出码不符');
      check(records[count].prompt_chars === charCount(input) && record.stdout_chars === charCount(result.stdout),
        'history 的 prompt_chars 或 stdout_chars 不符');
      check(records.slice(count, -1).every((row) => row.stdout_chars === 0), '中间轮不应输出 stdout');
      return { ...result, footer, record, records: records.slice(count), log: fs.readFileSync(logPath, 'utf8') };
    };
    const exitIs = (result, code) => check(result.status === code,
      `退出码应为 ${code}，实际 ${result.status}: ${result.stdout.trim()} ${result.stderr.trim()}`);
    let complete;
    let warning;
    let fixed;
    const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    const nodeCommand = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
    const verifyFile = (name) => nodeCommand(`process.exit(require('node:fs').existsSync(${JSON.stringify(name)}) ? 0 : 7)`);
    const progressPath = path.join(home, 'progress.md');
    const progressLines = () => fs.readFileSync(progressPath, 'utf8').trimEnd().split('\n');
    const attempts = () => fs.readFileSync(hookAttempts, 'utf8').trimEnd().split('\n').length;
    const conclusion = '结论:\n  - 调查入口正常；依据: codex-stub → 完成\n';
    let committed;
    const limitPath = path.join(home, 'state', 'codex-limit.json');
    const limitState = () => JSON.parse(fs.readFileSync(limitPath, 'utf8')).accounts['selftest-account'];
    const saveLimit = (state) => {
      fs.mkdirSync(path.dirname(limitPath), { recursive: true });
      fs.writeFileSync(limitPath, JSON.stringify({ accounts: { 'selftest-account': state } }));
    };
    const seedLimit = (overrides = {}) => {
      const resets = Math.floor(Date.now() / 1000) + 7200;
      const state = { type: '5h', resets_at: resets, detected_at: new Date().toISOString(), last_checked_at: null,
        source: 'session', snapshot: { primary: { used_percent: 100, resets_at: resets, window_minutes: 300 },
          secondary: { used_percent: 3, resets_at: resets + 604800, window_minutes: 10080 }, rate_limit_reached_type: null }, ...overrides };
      saveLimit(state);
      return state;
    };
    const resetFailCount = (name) => fs.rmSync(path.join(home, 'stub-sessions', `${name}.count`), { force: true });
    const appMode = (mode, resets_at) => fs.writeFileSync(path.join(home, 'stub-rate-limits.json'), JSON.stringify({ mode, resets_at }));
    const appCalls = () => {
      try { return fs.readFileSync(path.join(home, 'stub-app-server.jsonl'), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).filter((row) => row.event === 'start'); } catch { return []; }
    };
    const routeConfig = structuredClone(config);
    routeConfig.ccSwitch.enabled = true;
    const deviceDir = routeConfig.ccSwitch.deviceDir;
    const databasePath = routeConfig.ccSwitch.databasePath;
    const routeKey = 'SELFTEST_PRIVATE_KEY';
    const routeURL = 'https://upstream.fixture.invalid/v1?private=SELFTEST_PRIVATE_ENDPOINT';
    const routeToml = (endpoint = routeURL, key = routeKey) => `model_provider = "up.stream"\n` +
      `[model_providers."up.stream"]\nname = "Fixture"\nbase_url = ${JSON.stringify(endpoint)}\n` +
      `requires_openai_auth = true\nexperimental_bearer_token = ${JSON.stringify(key)}\n` +
      '[model_providers.openai_http]\nbase_url = "https://inactive.fixture.invalid/v1"\n';
    const claudeSettings = (endpoint = routeURL, key = routeKey) => ({ env: {
      ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku' } });
    const writeJSON = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const deviceSettings = (update = {}) => writeJSON(path.join(deviceDir, 'settings.json'), {
      currentProviderCodex: 'device-codex', currentProviderClaude: 'device-claude', ...update });
    const modeState = (codex = {}, claude = {}, version = 1) => writeJSON(path.join(deviceDir, 'live-state.json'), {
      version, apps: { codex: { mode: 'direct', attached: false, ...codex }, claude: { mode: 'direct', attached: false, ...claude } } });
    const authFixture = () => writeJSON(path.join(env.CODEX_HOME, 'auth.json'), {
      auth_mode: 'chatgpt', tokens: { account_id: 'selftest-account', access_token: 'SELFTEST_PRIVATE_ACCESS', refresh_token: 'SELFTEST_PRIVATE_REFRESH' } });
    const officialMirror = 'model_provider = "custom"\n[model_providers.custom]\nname = "OpenAI"\n' +
      'requires_openai_auth = true\nsupports_websockets = true\nwire_api = "responses"\n';
    const databaseEdit = async (edit) => {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(databasePath);
      try { edit(database); } finally { database.close(); }
    };
    const resetRoutes = async () => {
      for (const file of ['.claude.json', 'stub-claude-auth.json']) fs.rmSync(path.join(home, file), { force: true });
      for (const directory of [deviceDir, path.dirname(databasePath), path.join(home, '.claude')]) fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(deviceDir, { recursive: true });
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      deviceSettings();
      modeState();
      authFixture();
      fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml());
      writeJSON(path.join(home, '.claude', 'settings.json'), claudeSettings());
      await databaseEdit((database) => {
        database.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, category TEXT, settings_config TEXT, meta TEXT, is_current INTEGER, provider_type TEXT, PRIMARY KEY (id, app_type))');
        const insert = database.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const app of ['codex', 'claude']) {
          const settings = (url, key) => app === 'codex' ? { config: routeToml(url, key), auth: { OPENAI_API_KEY: key ?? routeKey } } : claudeSettings(url, key);
          insert.run(`device-${app}`, app, `Fixture ${app}`, 'third_party', JSON.stringify(settings()), '{}', 0, null);
          insert.run(`database-${app}`, app, `Database ${app}`, 'third_party', JSON.stringify(settings()), '{}', 1, null);
          insert.run(`proxy-${app}`, app, `Proxy ${app}`, 'third_party', JSON.stringify(settings('https://proxy.fixture.invalid/v1', 'SELFTEST_PROXY_KEY')), '{}', 0, null);
          insert.run(`official-${app}`, app, `Official ${app}`, 'official', JSON.stringify(app === 'codex' ? { config: '', auth: {} } : { env: {} }), '{}', 0, null);
        }
      });
    };
    const resolveRoutes = (overrides = {}) => resolveDispatchContext(routeConfig, { home, env, cwd: repo, ...overrides });
    const withRoutedFixture = async (test) => {
      await resetRoutes();
      for (const file of ['cooldown.json', 'codex-limit.json', 'provider-limit.json', 'claude-limit.json']) fs.rmSync(path.join(home, 'state', file), { force: true });
      const previousConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(routeConfig));
      const previousTimeout = dispatchTimeout;
      // 外层测试需容纳 auth status 的 5 秒超时、路由重读及派发收尾。
      dispatchTimeout = 15_000;
      try { await test(); } finally {
        dispatchTimeout = previousTimeout;
        fs.writeFileSync(path.join(home, 'config.json'), previousConfig);
      }
    };
    const useSubscription = () => {
      deviceSettings({ currentProviderCodex: 'official-codex' });
      fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'model_provider = "openai"\n');
      authFixture();
    };
    const useApi = async (id = 'device-codex', endpoint = routeURL) => {
      deviceSettings({ currentProviderCodex: id });
      fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml(endpoint));
      await databaseEdit((database) => database.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?')
        .run(JSON.stringify({ config: routeToml(endpoint), auth: { OPENAI_API_KEY: routeKey } }), id, 'codex'));
    };
    const providerLimitPath = path.join(home, 'state', 'provider-limit.json');
    const providerStates = () => fs.existsSync(providerLimitPath) ? JSON.parse(fs.readFileSync(providerLimitPath, 'utf8')).providers : {};
    const cooldownPath = path.join(home, 'state', 'cooldown.json');
    const invocationRows = () => fs.readFileSync(path.join(home, 'stub-invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const claudeCalls = () => {
      try { return fs.readFileSync(path.join(home, 'stub-claude-invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
      catch { return []; }
    };
    const claudeAccount = (used = 79, changes = {}, directory = home) => writeJSON(path.join(directory, '.claude.json'), {
      oauthAccount: { accountUuid: 'SELFTEST_PRIVATE_CLAUDE_ACCOUNT' }, cachedUsageUtilization: {
        accountUuid: 'SELFTEST_PRIVATE_CLAUDE_ACCOUNT', fetchedAtMs: Date.now(),
        utilization: { seven_day: { utilization: used, resets_at: new Date(Date.now() + 7200_000).toISOString() } }, ...changes } });
    const useClaudeSubscription = (used = null) => {
      deviceSettings({ currentProviderClaude: 'official-claude' });
      writeJSON(path.join(home, '.claude', 'settings.json'), { env: {} });
      writeJSON(path.join(home, 'stub-claude-auth.json'), { loggedIn: true, authMethod: 'claude.ai' });
      if (used !== null) claudeAccount(used);
    };
    const routeSnapshot = () => {
      const files = {};
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else files[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
      };
      visit(deviceDir); visit(path.dirname(databasePath));
      return JSON.stringify(files);
    };
    const noRouteSecrets = (value) => check(!/SELFTEST_PRIVATE|SELFTEST_PROXY_KEY|https?:\/\/|upstream\.fixture/.test(value), '服务商解析泄露密钥、token 或 endpoint');
    const invocations = () => fs.readFileSync(path.join(home, 'stub-invocations.jsonl'), 'utf8').trim().split('\n').length;
    const probeHome = path.join(tmpDir, 'probe-home');
    const retryHome = path.join(tmpDir, 'retry-home');
    const probeClaude = path.join(tmpDir, 'probe-claude');
    const probeCodex = path.resolve(path.dirname(SCRIPT_PATH), '../test/codex-stub');
    const probeConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    probeConfig.ccSwitch = { enabled: false };
    for (const directory of [probeHome, retryHome]) fs.mkdirSync(directory);
    for (const directory of [probeHome, retryHome]) fs.copyFileSync(path.join(ROOT, 'agents.json'), path.join(directory, 'agents.json'));
    fs.writeFileSync(path.join(probeHome, 'config.json'), JSON.stringify(probeConfig, null, 2) + '\n');
    fs.writeFileSync(path.join(retryHome, 'config.json'), JSON.stringify(probeConfig, null, 2) + '\n');
    fs.writeFileSync(probeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const probeEnv = { ...env, AGENT_ROUTE_HOME: probeHome,
      AGENT_ROUTE_PROBE_JSON: JSON.stringify({ claude: probeClaude, codex: probeCodex }) };
    const probeRun = (args, options = {}) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      env: options.env ?? probeEnv, cwd: options.cwd ?? probeHome, input: options.input,
      encoding: 'utf8', timeout: options.timeout ?? 5000 });
    const configuredRoot = path.join(tmpDir, 'configured-root');
    const configuredState = path.join(tmpDir, 'configured-state');
    const configuredHome = path.join(tmpDir, 'configured-home');
    fs.mkdirSync(path.join(configuredRoot, 'bin'), { recursive: true });
    fs.mkdirSync(configuredHome, { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(configuredRoot, 'bin', 'agent-route'));
    fs.copyFileSync(CONFIG_FILE, path.join(configuredRoot, 'config.json'));
    fs.copyFileSync(path.join(ROOT, 'agents.json'), path.join(configuredRoot, 'agents.json'));
    const configuredConfig = JSON.parse(fs.readFileSync(path.join(configuredRoot, 'config.json'), 'utf8'));
    configuredConfig.codexBin = probeCodex;
    configuredConfig.claudeBin = probeCodex;
    configuredConfig.ccSwitch = { enabled: false };
    fs.writeFileSync(path.join(configuredRoot, 'config.json'), JSON.stringify(configuredConfig, null, 2) + '\n');
    fs.writeFileSync(path.join(configuredRoot, 'config.local.json'), JSON.stringify({
      codexBin: probeCodex, claudeBin: probeCodex, stateDir: configuredState,
    }) + '\n');
    const configuredEnv = { ...env, HOME: configuredHome, CODEX_HOME: path.join(configuredHome, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(configuredHome, '.claude'), XDG_CONFIG_HOME: path.join(configuredHome, '.config'),
      TMPDIR: path.join(configuredHome, 'tmp'), AGENT_ROUTE_HOME: undefined };
    for (const key of Object.keys(configuredEnv)) if (key.startsWith('AGENT_ROUTE_')) delete configuredEnv[key];
    fs.mkdirSync(path.join(configuredHome, '.codex'), { recursive: true });
    fs.mkdirSync(configuredEnv.TMPDIR, { recursive: true });
    fs.writeFileSync(path.join(configuredHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'configured-account' } }));
    fs.writeFileSync(path.join(configuredHome, 'selftest-isolation.json'), JSON.stringify({
      home: configuredHome, codexHome: path.join(configuredHome, '.codex'), root: tmpDir,
    }));
    const configuredRun = (args, input = '') => spawnSync(process.execPath, [path.join(configuredRoot, 'bin', 'agent-route'), ...args], {
      env: configuredEnv, cwd: configuredRoot, input, encoding: 'utf8', timeout: dispatchTimeout });
    const scenarios = [
      [0, '缺 config.local.json 时自动生成', () => {
        fs.rmSync(path.join(probeHome, 'config.local.json'), { force: true });
        const result = probeRun(['status']);
        check(!result.error && result.status === 0, `setup probe 失败: ${result.stderr}`);
        const local = JSON.parse(fs.readFileSync(path.join(probeHome, 'config.local.json'), 'utf8'));
        check(local.claudeBin === probeClaude && local.codexBin === probeCodex, '缺少 local 配置时未生成两项路径');
      }],
      [0.1, 'local 覆盖 config.json 的值', () => {
        const overrideClaude = path.join(tmpDir, 'override-claude');
        const overrideCodex = path.join(tmpDir, 'override-codex');
        fs.writeFileSync(overrideClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(overrideCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(path.join(probeHome, 'config.local.json'), JSON.stringify({
          claudeBin: overrideClaude, codexBin: overrideCodex, stateDir: configuredState,
        }) + '\n');
        const result = probeRun(['status']);
        check(!result.error && result.status === 0, `local override 失败: ${result.stderr}`);
        const local = JSON.parse(fs.readFileSync(path.join(probeHome, 'config.local.json'), 'utf8'));
        check(local.claudeBin === overrideClaude && local.codexBin === overrideCodex, 'local 未覆盖 config.json');
        const clear = probeRun(['clear-cooldown']);
        check(clear.status === 0 && result.stdout.includes(`state dir: ${path.join(probeHome, 'state')}`) &&
          fs.existsSync(path.join(probeHome, 'state', 'cooldown.json')) &&
          !fs.existsSync(path.join(configuredState, 'cooldown.json')), 'AGENT_ROUTE_HOME 未忽略 stateDir');
      }],
      [0.2, '两种方式都找不到时输出 ERROR', () => {
        const missingEnv = { ...probeEnv, AGENT_ROUTE_HOME: probeHome,
          AGENT_ROUTE_PROBE_JSON: JSON.stringify({ claude: path.join(tmpDir, 'missing-claude'), codex: path.join(tmpDir, 'missing-codex') }) };
        fs.rmSync(path.join(probeHome, 'config.local.json'), { force: true });
        const result = probeRun(['setup'], { env: missingEnv });
        check(result.status === 12 && result.stdout.includes('ERROR') && result.stdout.includes('claude') && result.stdout.includes('codex'),
          '探测失败时未输出 ERROR');
      }],
      [0.3, '路径失效时重新探测并更新', () => {
        const stale = path.join(retryHome, 'missing-codex');
        fs.writeFileSync(path.join(retryHome, 'config.local.json'), JSON.stringify({ claudeBin: probeClaude, codexBin: stale }) + '\n');
        const retryEnv = { ...probeEnv, AGENT_ROUTE_HOME: retryHome };
        const result = probeRun(['tier1', '--no-claude', '--cwd', repo], {
          env: retryEnv, cwd: retryHome, input: 'AGENT_ROUTE_SELFTEST:complete\n任务字符计数 🧪\n', timeout: dispatchTimeout });
        const retryLog = result.stdout.match(/^log: (.+)$/m)?.[1];
        const retryDetail = retryLog && fs.existsSync(retryLog) ? fs.readFileSync(retryLog, 'utf8').slice(-500) : result.stderr;
        check(!result.error && result.status === 0, `失效路径重试失败: ${result.stdout} ${retryDetail}`);
        const local = JSON.parse(fs.readFileSync(path.join(retryHome, 'config.local.json'), 'utf8'));
        check(local.codexBin === probeCodex, '失效路径重试后未更新 codexBin');
        const status = configuredRun(['status']);
        check(status.status === 0 && status.stdout.includes(`state dir: ${configuredState}`) &&
          status.stdout.includes(`log dir: ${path.join(configuredRoot, 'logs')}`), 'stateDir 或日志目录状态输出不符');
        const dispatch = configuredRun(['tier1', '--no-claude', '--cwd', configuredRoot], 'AGENT_ROUTE_SELFTEST:complete\n');
        check(dispatch.status === 0 && fs.existsSync(path.join(configuredState, 'history.jsonl')) &&
          fs.readdirSync(path.join(configuredRoot, 'logs')).some((name) => name.endsWith('.log')) &&
          !fs.existsSync(path.join(configuredRoot, 'state', 'history.jsonl')),
          `stateDir 未共享状态或日志跟随 stateDir: status=${dispatch.status} stderr=${dispatch.stderr.trim()} stdout=${dispatch.stdout.trim()}`);
      }],
      [1, '汇报完成', () => {
        complete = run('complete');
        exitIs(complete, 0);
        check(complete.stdout.startsWith(`完成 | 改动: 无 | 验证: codex-stub → 完成\n${conclusion}\n---\n`),
          '满足条件时未精简 stdout');
        check(/^route: tier1 \S+ \S+ \| \d+s \| 1k tok \| complete \| id \S+\n$/.test(complete.footer),
          'footer 未按单行格式压缩 model、elapsed、tokens、status 和 id');
      }],
      [2, '汇报部分完成', () => {
        const result = run('partial');
        exitIs(result, 11);
        check(result.stdout.startsWith('状态: 部分完成\n') && /\| partial \|/.test(result.footer),
          '部分完成未保留完整汇报或 footer 缺少 partial');
      }],
      [3, '汇报无状态行', () => {
        const result = run('unknown');
        exitIs(result, 11);
        check(result.stdout.startsWith(`${conclusion}改动文件: 无\n`) && /\| unknown \|/.test(result.footer),
          '未知状态未保留完整汇报或 footer 缺少 unknown');
      }],
      [4, '只读写入已跟踪文件', () => {
        warning = run('tracked-write');
        exitIs(warning, 0);
        check(warning.stdout.startsWith('状态: 完成\n'), '有 WARNING 时未保留完整汇报');
        check(/^WARNING:.*git 状态.*tracked\.txt/m.test(warning.footer), 'WARNING 未包含 git 状态变化');
        check(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8').includes('stub write'), 'stub 未修改已跟踪文件');
        const rootCwdHome = path.join(tmpDir, 'root-cwd-home');
        fs.mkdirSync(path.join(rootCwdHome, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(rootCwdHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'root-cwd' } }));
        fs.writeFileSync(path.join(rootCwdHome, 'selftest-isolation.json'), JSON.stringify({
          home: rootCwdHome, codexHome: path.join(rootCwdHome, '.codex'), root: tmpDir,
        }));
        const rootCwdEnv = { ...env, HOME: rootCwdHome, CODEX_HOME: path.join(rootCwdHome, '.codex'),
          CLAUDE_CONFIG_DIR: path.join(rootCwdHome, '.claude'), AGENT_ROUTE_HOME: home };
        const rootCwd = spawnSync(process.execPath, [SCRIPT_PATH, 'tier1', '--no-claude', '--cwd', home], {
          env: rootCwdEnv, cwd: home, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: dispatchTimeout });
        check(rootCwd.status === 0 && !rootCwd.stdout.includes('WARNING'), 'ROOT 位于 --cwd 内时误报 WARNING');
      }],
      [5, '忽略目录写入与 exclude', () => {
        const result = run('ignored-write', ['--exclude', 'excluded']);
        exitIs(result, 0);
        check(/^WARNING:.*ignored\/written\.txt/m.test(result.footer), 'WARNING 未包含忽略目录的写入');
        check(!result.footer.includes('excluded/written.txt'), 'WARNING 包含 --exclude 路径');
        check(fs.existsSync(path.join(repo, 'excluded', 'written.txt')), 'stub 未写入 --exclude 目录');
      }],
      [6, '只写 __pycache__', () => {
        const result = run('pycache');
        exitIs(result, 0);
        check(!result.footer.includes('WARNING'), '__pycache__ 写入触发了 WARNING');
        check(fs.existsSync(path.join(repo, '__pycache__', 'selftest.pyc')), 'stub 未写入 __pycache__');
      }],
      [7, '成功摘要与告警完整日志', () => {
        check(complete && warning, '缺少场景 1 或 4 的结果');
        check(complete.log.includes('log-mode: summary') && !complete.log.includes('SELFTEST_STUB_TRACE'),
          '成功日志未压缩成摘要');
        check(!warning.log.includes('log-mode: summary') && warning.log.includes('SELFTEST_STUB_TRACE') &&
          /session id: [0-9a-f-]{36}/.test(warning.log) && warning.log.includes('tokens used\n1,234'),
          '告警日志未保留完整 stub 输出');
      }],
      [8, '非零退出与临时 HOME 冷却', () => {
        const result = run('failure');
        exitIs(result, 10);
        check(result.stdout.startsWith('FALLBACK\n') && result.stdout.includes('codex 退出码 1'), '未输出预期 FALLBACK 块');
        const cooldown = JSON.parse(fs.readFileSync(path.join(home, 'state', 'cooldown.json'), 'utf8'));
        check(Date.parse(cooldown[config.tiers.tier1.codex.model]) > Date.now(), '临时 HOME 未写入有效冷却');
        check(result.record.status === 'fallback' && result.record.fallback === true, 'FALLBACK 缺少 history 状态');
      }],
      [9, 'history、stats 与旧日志回填', () => {
        const result = run('complete', ['--write']);
        exitIs(result, 0);
        const record = result.record;
        for (const key of ['time', 'tier', 'model', 'effort', 'monitor', 'write', 'fallback', 'status', 'exit_code',
          'elapsed', 'tokens', 'session', 'log_id', 'cwd', 'prompt_chars', 'stdout_chars']) {
          check(Object.hasOwn(record, key) && record[key] !== null, `history 缺少字段 ${key}`);
        }
        check(record.tier === 'tier1' && record.model === config.tiers.tier1.codex.model &&
          record.effort === config.tiers.tier1.codex.effort && record.monitor === false && record.write === true &&
          record.fallback === false && record.status === 'complete' && record.tokens === 1234 &&
          samePath(record.cwd, repo) && Number.isFinite(Date.parse(record.time)) && record.elapsed >= 0,
          'history 字段值不符');
        check(record.resumed_from === null, '普通派发的 resumed_from 应为空');
        check(result.log.includes(`session id: ${record.session}`) &&
          /^finish: .*elapsed=\d+ .*session=[0-9a-f-]{36}/m.test(result.log), '摘要缺少 session 或 finish 的 elapsed/session');
        const monitored = run('monitor', ['--monitor']);
        exitIs(monitored, 0);
        check(monitored.record.monitor === true, 'monitor 未单独记录');
        const savedConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
        try {
          fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, claudeBin: path.join(home, 'missing-claude') }));
          const error = run('failure', [], true);
          exitIs(error, 12);
          check(error.stdout.startsWith('ERROR\n') && error.record.status === 'error' && error.record.fallback === true,
            'ERROR 缺少 history 状态');
        } finally { fs.writeFileSync(path.join(home, 'config.json'), savedConfig); }
        const legacyId = '20000101-000000-tier2-1';
        fs.writeFileSync(path.join(home, 'logs', `${legacyId}.log`),
          'tier: tier2\nmodel: legacy-model\neffort: low\nwrite: false\nfinish: status=complete tokens=2,000\n');
        const unfinishedId = '20000101-000001-tier2-2';
        fs.writeFileSync(path.join(home, 'logs', `${unfinishedId}.log`),
          'tier: tier2\nmodel: unfinished-model\neffort: low\nexec: codex exec\nOpenAI Codex\nfinish: status=complete tokens=9,999\nlog-mode: summary\n--- 最终汇报 ---\n仍在执行\n');
        const count = history().length;
        const runStats = (args = []) => {
          const statsResult = spawnSync(process.execPath, [SCRIPT_PATH, 'stats', ...args],
            { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
          exitIs(statsResult, 0);
          return statsResult.stdout;
        };
        const output = runStats();
        const expected = history().filter((row) => row.tier === record.tier && row.model === record.model &&
          row.effort === record.effort && row.monitor === false).length;
        const row = output.split('\n').find((line) => line.startsWith(`tier1  `) &&
          line.includes(record.model) && line.includes(record.effort) && /\bfalse\b/.test(line));
        check(row && row.trim().split(/\s+/)[4] === String(expected), 'stats 缺少对应分组或次数不符');
        check(output.split('\n').some((line) => line.startsWith('tier1  ') && /\btrue\b/.test(line)), 'stats 缺少 monitor 分组');
        check(history().length === count + 2, 'stats 应只回填缺少的日志 id');
        const legacy = history().find((row) => row.log_id === legacyId);
        check(legacy.tokens === 2000 && legacy.elapsed === null && legacy.prompt_chars === null &&
          legacy.stdout_chars === null && legacy.session === null && legacy.exit_code === null, '旧日志缺失字段未留空');
        const unfinished = history().find((row) => row.log_id === unfinishedId);
        check(unfinished.status === null && unfinished.tokens === null, '把日志正文中的 finish 当成了派发结果');
        check(!runStats(['--days', '1']).includes('legacy-model'), '--days 未排除旧记录');
        check(history().length === count + 2, '重复 stats 导致重复回填');
        fs.unlinkSync(path.join(home, 'logs', `${legacyId}.log`));
        check(runStats().includes('legacy-model'), '删除日志后 history 统计丢失');
      }],
      [10, '日志 id 续跑、工作目录和本次权限', () => {
        const source = run('complete', ['--write', '--cwd', repoAlias]);
        exitIs(source, 0);
        const id = source.record.log_id;
        const session = source.record.session;
        check(samePath(source.record.cwd, repoAlias) && source.log.includes(`cwd: ${fs.realpathSync(repoAlias)}\n`),
          '原派发未保存规范化 cwd');
        // 模拟旧 history 保存了目录别名，续跑查找时也应规范化。
        fs.writeFileSync(historyPath, history().map((row) => JSON.stringify(row.log_id === id ? { ...row, cwd: repoAlias } : row))
          .join('\n') + '\n');
        // 原日志已经清理时，仍应优先使用 history；调用方所在目录与原 cwd 不同。
        fs.unlinkSync(path.join(home, 'logs', `${id}.log`));
        const resumed = run('complete', ['--resume', id], true, { inheritCwd: true });
        exitIs(resumed, 0);
        check(resumed.log.includes(`resume session: ${session}`) && resumeCwdIs(resumed, repo),
          'stub 未收到原 session 或进程 cwd');
        check(resumed.footer.includes(`resumed ${id}`) && resumed.record.resumed_from === id &&
          resumed.record.session === session && samePath(resumed.record.cwd, repo) && resumed.record.write === false &&
          resumed.log.includes(`cwd: ${fs.realpathSync(repoAlias)}\n`),
          '续跑 footer、history 或本次只读模式不符');
        check(resumed.log.includes(`exec resume ${session} - `), '未调用 exec resume <session> -');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${resumed.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('模式: 只读，除报告文件') && prompt.includes(RULES) && prompt.includes(READ_ONLY_REPORT_FOOTER),
          '续跑 prompt 缺少本次模式、规则或汇报格式');

        const readonly = run('tracked-write', ['--resume', id], true, { inheritCwd: true });
        exitIs(readonly, 0);
        check(readonly.footer.includes('WARNING') && readonly.record.write === false,
          '从可写派发续跑时未按本次只读模式检查');
        const writable = run('tracked-write', ['--resume', readonly.record.log_id, '--write', '--effort', 'low'], true,
          { inheritCwd: true });
        exitIs(writable, 0);
        check(!writable.footer.includes('WARNING') && writable.record.write === true && writable.record.effort === 'low',
          '续跑未采用本次 --write 或 --effort');
        const writablePrompt = fs.readFileSync(path.join(home, 'logs', `${writable.record.log_id}.prompt.md`), 'utf8');
        check(writablePrompt.includes('模式: 可修改文件'), '可写续跑 prompt 模式不符');

        const legacyId = '20000101-000000-tier1-10';
        fs.writeFileSync(path.join(home, 'logs', `${legacyId}.log`),
          `tier: tier1\ncwd: ${repoAlias}\nwrite: true\nexec: codex exec\nsession id: ${session}\n`);
        const legacy = run('complete', ['--resume', legacyId], true, { inheritCwd: true });
        exitIs(legacy, 0);
        check(legacy.record.session === session && samePath(legacy.record.cwd, repo) && legacy.record.resumed_from === legacyId &&
          resumeCwdIs(legacy, repo) && legacy.log.includes(`cwd: ${fs.realpathSync(repoAlias)}\n`),
          '未从旧日志读取 session、规范化 cwd 和 tier');

        const otherCwd = path.join(tmpDir, 'other-repo');
        fs.mkdirSync(otherCwd);
        const otherAlias = path.join(tmpDir, 'other-alias');
        fs.symlinkSync(otherCwd, otherAlias, 'dir');
        const overridden = run('complete', ['--resume', legacyId, '--cwd', otherAlias], true);
        exitIs(overridden, 0);
        check(samePath(overridden.record.cwd, otherCwd) && resumeCwdIs(overridden, otherCwd) &&
          overridden.log.includes(`cwd: ${fs.realpathSync(otherAlias)}\n`),
          '--cwd 未覆盖原工作目录');
        const direct = run('complete', ['--resume', session, '--cwd', repoAlias], true);
        exitIs(direct, 0);
        check(direct.record.session === session && direct.record.resumed_from === session && resumeCwdIs(direct, repo) &&
          direct.footer.includes(`resumed ${session}`), 'UUID 未直接作为 session 续跑');

        // 摘要日志也要保留续跑来源，供 history 丢失后的 stats 回填。
        fs.writeFileSync(historyPath, history().filter((row) => row.log_id !== resumed.record.log_id)
          .map((row) => JSON.stringify(row)).join('\n') + '\n');
        const statsResult = spawnSync(process.execPath, [SCRIPT_PATH, 'stats'],
          { env, cwd: home, encoding: 'utf8', timeout: 5000 });
        exitIs(statsResult, 0);
        const recovered = history().find((row) => row.log_id === resumed.record.log_id);
        check(recovered?.resumed_from === id && recovered.session === session && recovered.status === 'complete' &&
          samePath(recovered.cwd, repo),
          '续跑摘要回填丢失 resumed_from、session 或 finish');
      }],
      [11, '续跑参数错误仍为 ERROR 12，不重试、不调用 Claude 且不写冷却', () => {
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        const errorIs = (result, reason, cooldown = null) => {
          exitIs(result, 12);
          check(result.stdout.startsWith('ERROR\n') && result.stdout.includes(reason), '未输出预期 ERROR 原因');
          check(result.record.status === 'error' && result.record.fallback === false &&
            !/^exec: .* "-p"/m.test(result.log), '续跑参数错误调用了 Claude fallback');
          check((fs.existsSync(cooldownPath) ? fs.readFileSync(cooldownPath, 'utf8') : null) === cooldown,
            '续跑参数错误写入或修改了冷却');
          check(!/^attempt/m.test(result.log) && result.record.attempt === null, '续跑参数错误不应进入重试流程');
        };
        const missing = run('complete', ['--resume', '29990101-000000-tier1-11'], true);
        errorIs(missing, '找不到 session');
        check(!/^exec: /m.test(missing.log), '来源不存在时仍启动了执行方');

        const noSessionId = '20000101-000001-tier1-11';
        fs.appendFileSync(historyPath, JSON.stringify({ log_id: noSessionId, session: null, cwd: repo, tier: 'tier1' }) + '\n');
        fs.writeFileSync(path.join(home, 'logs', `${noSessionId}.log`),
          `tier: tier1\ncwd: ${repo}\nsession id: ${complete.record.session}\n`);
        const noSession = run('complete', ['--resume', noSessionId], true);
        errorIs(noSession, '找不到 session');
        check(!/^exec: /m.test(noSession.log), 'history 已有记录时仍从日志补用了 session');

        const otherTierId = '20000101-000002-tier2-11';
        fs.writeFileSync(path.join(home, 'logs', `${otherTierId}.log`),
          `tier: tier2\ncwd: ${repo}\nsession id: ${complete.record.session}\n`);
        const mismatch = run('complete', ['--resume', otherTierId], true);
        errorIs(mismatch, 'tier 不一致');
        check(!/^exec: /m.test(mismatch.log), 'tier 不一致时仍启动了执行方');

        const savedCooldown = JSON.stringify({ [config.tiers.tier1.codex.model]: new Date(Date.now() + 60_000).toISOString() }) + '\n';
        fs.writeFileSync(cooldownPath, savedCooldown);
        const cooledMismatch = run('complete', ['--resume', otherTierId], true, { preserveCooldown: true });
        errorIs(cooledMismatch, 'tier 不一致', savedCooldown);

        const count = history().length;
        const noCwd = spawnSync(process.execPath, [SCRIPT_PATH, 'tier1', '--resume', complete.record.session],
          { env, cwd: home, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
        exitIs(noCwd, 2);
        check(noCwd.stderr.includes('必须同时指定 --cwd') && history().length === count &&
          fs.readFileSync(cooldownPath, 'utf8') === savedCooldown, 'UUID 未要求 --cwd 或参数错误产生了派发副作用');
      }],
      [12, 'monitor 无状态和报告 footer', () => {
        const result = run('monitor', ['--monitor']);
        exitIs(result, 0);
        check(result.stdout.startsWith('STATUS: OK\nselftest monitor\n'), 'monitor 未返回 STATUS 行和摘要');
        check(/^route: tier1 \S+ \S+ \| \d+s \| 1k tok \| n\/a \| id \S+\n$/.test(result.footer),
          'monitor footer 未使用精简单行格式');
      }],
      [13, 'verify 顺序、工作目录、只读授权写入与 history', () => {
        const first = nodeCommand("require('node:fs').writeFileSync('verify-order.txt', 'first'); console.log(process.cwd())");
        const second = nodeCommand("const fs = require('node:fs'); process.exit(fs.readFileSync('verify-order.txt', 'utf8') === 'first' ? 0 : 8)");
        const result = run('complete', ['--verify', first, '--verify', second]);
        exitIs(result, 0);
        check(result.stdout.startsWith(`完成 | 改动: 无 | 验证: codex-stub → 完成\n${conclusion}verify: PASS\n\n---\n`) &&
          !result.footer.includes('WARNING'),
          'verify PASS 未在 footer 之前输出，或 verify 写入触发只读告警');
        check(result.record.verify?.status === 'PASS' && result.record.verify.results.length === 2 &&
          result.record.verify.results.every((entry) => entry.exit_code === 0), 'history 未记录所有验证结果');
        check(fs.readFileSync(path.join(repo, 'verify-order.txt'), 'utf8') === 'first' && result.log.includes(first),
          'verify 未在 cwd 顺序运行或日志缺少原始命令');
      }],
      [14, 'verify 失败、最后 15 行和每行 200 字符、禁用返工', () => {
        const command = nodeCommand("for (let i = 1; i <= 20; i++) console.log('line-' + i + ':' + '界'.repeat(250)); console.error('stderr-last'); process.exit(9)");
        const result = run('complete', ['--write', '--fix-rounds', '0', '--verify', command,
          '--verify', nodeCommand("require('node:fs').writeFileSync('after-failure.txt', 'ran')")]);
        exitIs(result, 13);
        check(result.stdout.startsWith('状态: 完成\n'), 'verify FAIL 时未保留完整汇报');
        const failure = result.record.verify?.results[0];
        check(result.record.verify?.status === 'FAIL' && failure?.command === command && failure.exit_code === 9 &&
          failure.output.length === 15 && failure.output[0].startsWith('line-7:') &&
          failure.output.at(-1) === 'stderr-last' && failure.output.every((line) => charCount(line) <= 200),
          '失败命令、退出码或输出裁剪不符');
        check(result.stdout.includes(`verify: FAIL ${command} → exit 9`) && result.stdout.includes('stderr-last') &&
          result.log.includes('界'.repeat(250)) && !result.stdout.includes('界'.repeat(201)), 'stdout 或原始日志输出不符');
        check(fs.existsSync(path.join(repo, 'after-failure.txt')) && result.record.verify.results[1].exit_code === 0,
          '失败后没有继续依次运行其余 verify 命令');
        check(!result.footer.includes('fixed-after'), '--fix-rounds 0 仍触发返工');
      }],
      [15, '非完成汇报和 monitor 不执行 verify', () => {
        const command = nodeCommand("require('node:fs').writeFileSync('must-not-verify.txt', 'unexpected')");
        for (const scenario of ['partial', 'unknown', 'monitor']) {
          const result = run(scenario, [...(scenario === 'monitor' ? ['--monitor'] : []), '--verify', command]);
          exitIs(result, scenario === 'monitor' ? 0 : 11);
          check(result.record.verify === null && !result.stdout.includes('verify:'), '非完成汇报执行了 verify');
        }
        check(!fs.existsSync(path.join(repo, 'must-not-verify.txt')), '非完成汇报产生了 verify 写入');
      }],
      [16, 'stdout 相对路径、logs 标记、报告标记和日志原文', () => {
        const result = run('paths', ['--full-output']);
        exitIs(result, 0);
        check(result.stdout.includes('  - cwd: .\n') && result.stdout.includes('  - cwd-slash: .\n') &&
          result.stdout.includes('  - file: nested/a.txt\n') && result.stdout.includes('  - logs-dir: <logs>/\n') &&
          result.stdout.includes(`  - sibling: ${repo}-other/a.txt\n`) &&
          result.stdout.includes('  - logs: <logs>/artifact.log\n') &&
          result.stdout.includes(`  - report: <logs>/${result.record.log_id}.report.md\n`), 'stdout 路径压缩或前缀边界不符');
        check(result.footer.endsWith(' | report\n') && result.footer.trim().split('\n').length === 1 &&
          result.log.includes(`  - cwd: ${repo}\n`) && result.log.includes(`  - file: ${repo}/nested/a.txt\n`) &&
          result.log.includes(`  - logs: ${home}/logs/artifact.log\n`), '报告 footer 或日志原文不符');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('路径一律写相对工作目录的路径，命令只写关键部分，不重复解释器的完整路径。'),
          'REPORT_FOOTER 缺少路径和命令压缩要求');
        const nested = run('paths', ['--write', '--cwd', home, '--full-output']);
        exitIs(nested, 0);
        check(nested.stdout.includes('  - cwd: .\n') && nested.stdout.includes('  - logs: <logs>/artifact.log\n'),
          'logs 位于 cwd 内部时未优先替换较长路径');
      }],
      [17, '默认自动返工一轮、同线程、只输出最终汇报', () => {
        const command = verifyFile('fixable.txt');
        fixed = run('fixable', ['--write', '--verify', command], false, { rounds: 2 });
        exitIs(fixed, 0);
        const [first, last] = fixed.records;
        check(first.verify?.status === 'FAIL' && first.exit_code === 13 && last.verify?.status === 'PASS' &&
          last.resumed_from === first.log_id && last.session === first.session && first.resumed_from === null,
          '返工 history 未串联相同线程或验证结果不符');
        check(fixed.log.includes('  - round: 1\n') && !fixed.stdout.includes('  - round: 0\n') &&
          !fixed.stdout.includes('verify: FAIL') && fixed.footer.includes(' | fixed-after 1'), '输出包含中间轮或缺少返工 footer');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${last.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('自动返工：上轮 verify 失败。') && prompt.includes(`verify: FAIL ${command} → exit 7`) &&
          prompt.includes('完成后重新按规定格式汇报') && prompt.includes(RULES) && prompt.includes(REPORT_FOOTER) &&
          last.prompt_chars > 0, '返工 prompt 缺少固定说明、失败结果或本轮规则');
      }],
      [18, '多轮返工、失败输出回传和 resumed_from 链', () => {
        const command = nodeCommand("const ok = require('node:fs').existsSync('fix-twice.txt'); if (!ok) console.log('repair-tail'); process.exit(ok ? 0 : 6)");
        const result = run('fix-twice', ['--write', '--verify', command, '--fix-rounds', '2'], false, { rounds: 3 });
        exitIs(result, 0);
        check(result.records.every((row) => row.session === result.record.session) &&
          result.records.every((row, i, rows) => i === 0 || row.resumed_from === rows[i - 1].log_id) &&
          result.records.map((row) => row.exit_code).join(',') === '13,13,0', '多轮线程、链或退出码不符');
        check(result.log.includes('  - round: 2\n') && !result.stdout.includes('repair-tail') &&
          result.footer.includes(' | fixed-after 2'), '多轮输出未只保留最终轮');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('\nrepair-tail\n'), '返工 prompt 未包含失败命令最后输出');
      }],
      [19, '返工达到上限仍验证失败时退出 13', () => {
        const result = run('complete', ['--write', '--verify', nodeCommand('process.exit(5)'), '--fix-rounds', '2'],
          false, { rounds: 3 });
        exitIs(result, 13);
        check(result.records.every((row) => row.verify?.status === 'FAIL' && row.exit_code === 13) &&
          result.footer.includes(' | fixed-after 2') && (result.stdout.match(/^状态:/gm) ?? []).length === 1,
          '返工次数上限、最终退出码或单轮输出不符');
      }],
      [20, '只读验证失败不返工且验证写入不告警', () => {
        const result = run('complete', ['--verify', nodeCommand("require('node:fs').writeFileSync('readonly-verify.txt', 'ok'); process.exit(4)"),
          '--fix-rounds', '3']);
        exitIs(result, 13);
        check(result.record.verify?.status === 'FAIL' && !result.footer.includes('WARNING') &&
          !result.footer.includes('fixed-after') && fs.existsSync(path.join(repo, 'readonly-verify.txt')),
          '只读模式返工或把 verify 写入判为越权');
      }],
      [21, '无 verify 时 fix-rounds 不生效及参数校验', () => {
        const result = run('complete', ['--write', '--fix-rounds', '3']);
        exitIs(result, 0);
        check(result.record.verify === null && !result.footer.includes('fixed-after'), '无 verify 时仍触发返工');
        const count = history().length;
        for (const args of [['--fix-rounds', '-1'], ['--fix-rounds', '1.5'], ['--fix-rounds', '9007199254740992'],
          ['--fix-rounds'], ['--verify'], ['--verify', '']]) {
          const invalid = spawnSync(process.execPath, [SCRIPT_PATH, 'tier1', '--cwd', repo, ...args],
            { env, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
          check(!invalid.error, invalid.error?.message);
          exitIs(invalid, 2);
          check(invalid.stderr.includes('日志是 <ROOT>/logs/<id>.log，报告是 <ROOT>/logs/<id>.report.md'), 'usage 缺少日志和报告位置');
        }
        check(history().length === count, '参数错误仍写入 history');
      }],
      [22, '返工执行失败同样先重试，再写冷却并交给 Claude', () => {
        const result = run('fix-failure', ['--write', '--verify', nodeCommand('process.exit(3)')], true, { rounds: 6 });
        exitIs(result, 12);
        const cooldown = JSON.parse(fs.readFileSync(path.join(home, 'state', 'cooldown.json'), 'utf8'));
        check(result.stdout.startsWith('ERROR\n') && result.stdout.includes('claude: ') &&
          result.record.resumed_from === result.records[0].log_id && result.record.fallback === true &&
          result.record.attempt === 'claude fallback' &&
          result.records.slice(1, 5).map((row) => row.attempt).join() === 'resume,resume retry,fresh attempt 1,fresh attempt 2' &&
          new Set(result.records.map((row) => row.log_id)).size === 6 &&
          Date.parse(cooldown[config.tiers.tier1.codex.model]) > Date.now(),
          '返工失败未按重试、新线程、Claude 的顺序处理或日志 id 重复');
      }],
      [23, '返工汇报部分完成时停止且不再 verify', () => {
        const result = run('fix-partial', ['--write', '--verify', nodeCommand('process.exit(3)'), '--fix-rounds', '3'],
          false, { rounds: 2 });
        exitIs(result, 11);
        check(result.record.status === 'partial' && result.record.verify === null &&
          result.footer.includes(' | fixed-after 1') && !result.stdout.includes('verify:'), '部分完成后继续验证或返工');
      }],
      [24, 'verify 结果和返工链可从完整与摘要日志回填', () => {
        check(fixed, '缺少场景 17 的结果');
        const ids = new Set(fixed.records.map((row) => row.log_id));
        fs.writeFileSync(historyPath, history().filter((row) => !ids.has(row.log_id)).map((row) => JSON.stringify(row)).join('\n') + '\n');
        const result = spawnSync(process.execPath, [SCRIPT_PATH, 'stats'], { env, encoding: 'utf8', timeout: 5000 });
        check(!result.error, result.error?.message);
        exitIs(result, 0);
        for (const row of fixed.records) {
          const recovered = history().find((entry) => entry.log_id === row.log_id);
          check(JSON.stringify(recovered?.verify) === JSON.stringify(row.verify) && recovered?.resumed_from === row.resumed_from &&
            recovered?.session === row.session && recovered?.stdout_chars === row.stdout_chars, '回填丢失 verify、线程链或输出字符数');
        }
      }],
      [25, 'Claude fallback 同样执行 verify 并在原线程返工', () => {
        const result = run('claude-fixable', ['--write', '--verify', verifyFile('claude-fixable.txt')], true, { rounds: 2 });
        exitIs(result, 0);
        check(result.records.every((row) => row.fallback === true && row.session === result.record.session) &&
          result.records[0].verify?.status === 'FAIL' && result.record.verify?.status === 'PASS' &&
          result.record.resumed_from === result.records[0].log_id && result.log.includes(`"--resume" "${result.record.session}"`) &&
          result.footer.includes(' | fixed-after 1'), 'Claude 验证或同线程返工不符');
      }],
      [26, 'verify 超时与信号退出映射', () => {
        // 只在测试子进程中缩短十分钟定时器，真实验证仍固定为十分钟。
        const bootstrap = 'const original = globalThis.setTimeout; globalThis.setTimeout = (fn, delay, ...args) => original(fn, delay === 600000 ? 30 : delay, ...args);';
        const timed = run('complete', ['--verify', nodeCommand('setTimeout(() => {}, 30000)')], false,
          { nodeArgs: ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`] });
        exitIs(timed, 13);
        check(timed.record.verify?.results[0].exit_code === 124 && timed.log.includes('verify exit: 124 (timeout)'),
          'verify 超时没有终止命令并记为 exit 124');
        const signaled = run('complete', ['--verify', nodeCommand("process.kill(process.pid, 'SIGTERM')")]);
        exitIs(signaled, 13);
        check(signaled.record.verify?.results[0].exit_code === 143, 'verify 信号退出码未映射为 128 + signal');
      }],
      [27, 'progress 格式、label、新加坡时间和已有脏文件的内容变化', () => {
        fs.writeFileSync(progressPath, '# progress');
        const singaporeMinute = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore',
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
        const beforeMinute = singaporeMinute();
        const result = run('tracked-write', ['--write', '--progress-doc', progressPath, '--label', '阶段 O7']);
        exitIs(result, 0);
        const lines = progressLines();
        check(lines.length === 2 && lines[0] === '# progress', 'progress 未保留原内容或省略无偏差子行');
        const line = lines[1];
        check(/^- 阶段 O7 \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[\S+\] tier1 \S+ \S+ \| complete \| \d+s \| 1k tok \| verify - \| 改动: tracked\.txt$/.test(line),
          `progress 格式不符: ${line}`);
        check(line.includes(`[${result.record.log_id}]`) &&
          [beforeMinute, singaporeMinute()].some((minute) => line.includes(minute)), 'progress id 或新加坡分钟不符');
      }],
      [28, 'progress 覆盖非完成、verify FAIL、FALLBACK 和 ERROR', () => {
        for (const [scenario, args, code, status, verify, rounds] of [
          ['partial', [], 11, 'partial', '-'], ['unknown', [], 11, 'unknown', '-'],
          ['complete', ['--verify', nodeCommand('process.exit(8)')], 13, 'complete', 'FAIL'],
          ['failure', [], 10, 'fallback', '-'],
          ['failure', ['--resume', complete.record.log_id], 10, 'fallback', '-', 5],
        ]) {
          const count = progressLines().length;
          const result = run(scenario, [...args, '--progress-doc', progressPath], false, { rounds: rounds ?? 1 });
          exitIs(result, code);
          const lines = progressLines();
          check(lines.length === count + 1 && lines.at(-1).includes(`[${result.record.log_id}]`) &&
            lines.at(-1).includes(` | ${status} | `) && lines.at(-1).includes(` | verify ${verify} | `),
            '错误或非完成派发缺少单条 progress（重试的中间尝试不应写 progress）');
        }
      }],
      [29, '非 git progress 使用汇报文件、最多八项和两种子行', () => {
        fs.writeFileSync(progressPath, '');
        const result = run('progress-details', ['--write', '--cwd', home, '--progress-doc', progressPath]);
        exitIs(result, 0);
        const lines = progressLines();
        check(lines.length === 3 && lines[0].endsWith(` | 改动: ${Array.from({ length: 8 }, (_, i) => `file-${i + 1}.txt`).join(', ')}`) &&
          !lines[0].includes('file-9.txt') && lines[1] === '  - 偏差: 使用测试替身' &&
          lines[2] === '  - 遗留问题: 等待检查; 补充资料', '非 git 文件列表、相对路径、八项上限或子行不符');
      }],
      [30, 'progress 和 commit 参数错误在派发前退出 2', () => {
        const count = history().length;
        const sessions = fs.readdirSync(path.join(home, 'stub-sessions')).length;
        for (const args of [['--progress-doc', path.join(home, 'missing-progress.md')], ['--progress-doc', home],
          ['--progress-doc'], ['--commit', 'feat(selftest): readonly'], ['--write', '--commit', ''], ['--label']]) {
          const result = spawnSync(process.execPath, [SCRIPT_PATH, 'tier1', '--cwd', repo, ...args],
            { env, cwd: home, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
          check(!result.error, result.error?.message);
          exitIs(result, 2);
        }
        check(history().length === count && fs.readdirSync(path.join(home, 'stub-sessions')).length === sessions,
          '参数错误启动执行方或新增 history');
      }],
      [31, 'commit 只提交新变化，保留未变化的脏文件和预暂存内容', () => {
        const fixtures = ['existing-dirty.txt', 'existing-staged.txt', 'fresh-clean.txt', 'deleted.txt', 'renamed-old.txt'];
        for (const name of fixtures) fs.writeFileSync(path.join(repo, name), 'seed\n');
        git('add', '--', ...fixtures);
        git('commit', '--only', '--quiet', '-m', 'chore(selftest): seed commit paths', '--', ...fixtures);
        fs.appendFileSync(path.join(repo, 'existing-dirty.txt'), 'preexisting dirty\n');
        fs.appendFileSync(path.join(repo, 'existing-staged.txt'), 'preexisting staged\n');
        git('add', 'existing-staged.txt');
        fs.writeFileSync(path.join(repo, 'changed-untracked.txt'), 'preexisting untracked\n');
        fs.writeFileSync(path.join(repo, 'untouched-untracked.txt'), 'untouched\n');
        fs.writeFileSync(progressPath, '');
        const result = run('commit-mixed', ['--write', '--commit', 'feat(selftest): commit changed paths', '--progress-doc', progressPath]);
        exitIs(result, 0);
        const expected = ['existing-dirty.txt', 'fresh-clean.txt', 'changed-untracked.txt', 'new file 界.txt',
          'deleted.txt', 'renamed-old.txt', 'renamed new.txt'].sort();
        const names = git('-c', 'core.quotepath=false', 'show', '--pretty=format:', '--name-only', '--no-renames', 'HEAD').trim().split('\n').sort();
        check(JSON.stringify(names) === JSON.stringify(expected), `提交路径不符: ${names.join(', ')}`);
        check(git('diff', '--cached', '--name-only').trim() === 'existing-staged.txt' &&
          git('diff', '--name-only').includes('tracked.txt') &&
          git('ls-files', '--others', '--exclude-standard').includes('untouched-untracked.txt'), '派发前未变化的改动被提交或暂存状态丢失');
        check(result.record.commit === git('rev-parse', '--short', 'HEAD').trim() &&
          result.footer.endsWith(` | commit ${result.record.commit}\n`) &&
          progressLines()[0].includes(` | commit ${result.record.commit} | 改动: `) &&
          expected.every((name) => progressLines()[0].includes(name)), 'footer、history 或提交后的 progress 丢失 commit/路径');
        check(git('log', '-1', '--format=%s').trim() === 'feat(selftest): commit changed paths', '提交信息被改写');
        committed = result;
      }],
      [32, '本地 commit-msg hook 拒绝时仅尝试一次，退出 14 并保留 progress', () => {
        const head = git('rev-parse', 'HEAD');
        const count = attempts();
        fs.writeFileSync(progressPath, '');
        const result = run('tracked-write', ['--write', '--commit', 'feat(selftest): reject', '--progress-doc', progressPath]);
        exitIs(result, 14);
        check(result.footer.includes('\ncommit FAIL: selftest commit-msg rejected\n') &&
          result.record.commit === null && git('rev-parse', 'HEAD') === head && attempts() === count + 1,
          'hook 拒绝后重试、创建提交或缺少首行原因');
        check(progressLines().length === 1 && progressLines()[0].includes(`[${result.record.log_id}]`) &&
          !progressLines()[0].includes(' | commit '), 'commit 失败遗漏 progress 或记录了成功 hash');
      }],
      [33, '非完成、WARNING 或 verify FAIL 不提交', () => {
        const head = git('rev-parse', 'HEAD');
        const count = attempts();
        for (const [scenario, args, code] of [
          ['partial', [], 11], ['unknown', [], 11], ['report-warning', [], 0],
          ['complete', ['--verify', nodeCommand('process.exit(3)'), '--fix-rounds', '0'], 13],
        ]) {
          const result = run(scenario, ['--write', '--commit', 'feat(selftest): must not commit', ...args]);
          exitIs(result, code);
          check(result.stdout.startsWith(scenario === 'unknown' ? '改动文件:' : '状态:'),
            '不满足精简条件时未保留完整汇报');
          check(result.record.commit === null && !result.footer.includes(' | commit '), '不满足条件仍记录提交');
        }
        check(git('rev-parse', 'HEAD') === head && attempts() === count, '不满足提交条件仍调用 git commit');
      }],
      [34, '返工最终全部 PASS 才提交一次，progress 只追加最终轮', () => {
        fs.rmSync(path.join(repo, 'fixable.txt'), { force: true });
        fs.writeFileSync(progressPath, '');
        const count = attempts();
        const result = run('fixable', ['--write', '--commit', 'fix(selftest): commit final repair', '--progress-doc', progressPath,
          '--verify', verifyFile('fixable.txt'), '--verify', nodeCommand("require('node:fs').writeFileSync('verify-commit.txt', 'verified')")],
          false, { rounds: 2 });
        exitIs(result, 0);
        check(result.records[0].commit === null && result.record.commit && result.record.verify.status === 'PASS' &&
          result.record.verify.results.length === 2 && attempts() === count + 1, '返工期间提前提交或并非所有 verify PASS');
        const names = git('show', '--pretty=format:', '--name-only', 'HEAD').trim().split('\n').sort();
        check(JSON.stringify(names) === JSON.stringify(['fixable.txt', 'verify-commit.txt']), '返工快照遗漏首轮验证产物或混入已有改动');
        const lines = progressLines();
        check(lines.length === 1 && lines[0].includes(`[${result.record.log_id}]`) &&
          lines[0].includes(` | verify PASS | commit ${result.record.commit} | resumed ${result.records[0].log_id} | `),
          '返工 progress 包含中间轮或缺少最终提交与续跑来源');
      }],
      [35, '提交摘要回填保留 commit，Claude 错误和成功均追加 progress', () => {
        check(committed, '缺少提交结果');
        fs.writeFileSync(historyPath, history().filter((row) => row.log_id !== committed.record.log_id)
          .map((row) => JSON.stringify(row)).join('\n') + '\n');
        const statsResult = spawnSync(process.execPath, [SCRIPT_PATH, 'stats'], { env, encoding: 'utf8', timeout: 5000 });
        check(!statsResult.error, statsResult.error?.message);
        exitIs(statsResult, 0);
        check(history().find((row) => row.log_id === committed.record.log_id)?.commit === committed.record.commit,
          '从摘要回填时丢失 commit');
        for (const [scenario, code] of [['failure', 12], ['claude-fixable', 0]]) {
          fs.writeFileSync(progressPath, '');
          const result = run(scenario, ['--progress-doc', progressPath], true);
          exitIs(result, code);
          check(progressLines().length === 1 && progressLines()[0].includes(`tier1 ${result.record.model} ${result.record.effort} | ${result.record.status} | `),
            'Claude progress 缺失或没有使用实际 model、effort 和状态');
        }
      }],
      [36, '精简多行文件、首项验证、字符上限和完整日志进度', () => {
        fs.writeFileSync(progressPath, '');
        const result = run('compact-details', ['--write', '--cwd', home, '--progress-doc', progressPath]);
        exitIs(result, 0);
        const summary = result.stdout.match(/^完成 \| 改动: (.*) \| 验证: (.*)\n\n---\n/);
        check(summary && summary[1].startsWith('first.txt; 界🧪') && charCount(summary[1]) === 200 &&
          summary[2].startsWith('验🧪') && charCount(summary[2]) === 120 &&
          !result.stdout.includes('第二项'), '字段未压成一行、只取首项验证或字符上限不符');
        check(result.log.includes(`  - ${home}/first.txt\n`) && result.log.includes('  - 第二项 → PASS\n') &&
          result.log.includes(`${'界🧪'.repeat(110)}.txt`), '日志未保留完整原始汇报');
        check(progressLines().length === 1 &&
          progressLines()[0].endsWith(` | 改动: first.txt, ${'界🧪'.repeat(110)}.txt`),
          '精简 stdout 后非 git progress 丢失完整汇报文件列表');
      }],
      [37, '有偏差、遗留问题或空白栏时保留完整汇报', () => {
        for (const scenario of ['deviation', 'pending', 'empty-notes']) {
          const result = run(scenario);
          exitIs(result, 0);
          check(result.stdout.startsWith(`状态: 完成\n${conclusion}改动文件: 无\n验证: codex-stub → 完成\n`) &&
            result.stdout.includes(scenario === 'deviation' ? '偏差: 使用测试替身\n' :
              scenario === 'pending' ? '遗留问题: 等待检查\n' : '偏差:\n'),
            `${scenario} 未保留完整汇报`);
        }
      }],
      [38, '--full-output 保留完整汇报、verify 和 monitor', () => {
        for (const args of [[], ['--verify', nodeCommand('process.exit(0)')]]) {
          const result = run('complete', ['--full-output', ...args]);
          exitIs(result, 0);
          check(result.stdout.startsWith(`状态: 完成\n${conclusion}改动文件: 无\n验证: codex-stub → 完成\n偏差: 无\n遗留问题: 无\n`) &&
            result.stdout.includes('\nverify: PASS\n') === Boolean(args.length),
            '--full-output 未保留完整汇报或改变了 verify 输出');
        }
        const monitored = run('monitor', ['--monitor', '--full-output']);
        exitIs(monitored, 0);
        check(monitored.stdout.startsWith('STATUS: OK\nselftest monitor\n\n---\n') && monitored.record.status === 'n/a',
          '--full-output 改变了 monitor 输出');
      }],
      [39, '只读结论原样保留，其余字段折叠', () => {
        const result = run('conclusions');
        exitIs(result, 0);
        const findings = ['结论:', '  - 入口会校验输入；依据: src/router.js:route',
          '    说明: 保留  两个空格与换行。', '',
          `  - ${'调查🧪'.repeat(70)}；依据: rg entry → 2 matches`,
          '  - 错误分支会返回失败；依据: src/router.js:catchError', ''].join('\n');
        check(result.stdout.startsWith(`完成 | 改动: 无 | 验证: codex-stub → 完成\n${findings}\n---\n`) &&
          !result.footer.includes('WARNING'), '结论被折叠、截断或其余字段未折叠');
        check(result.log.includes(`状态: 完成\n${findings}改动文件: 无\n`), '日志未保留完整结论');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes(READ_ONLY_REPORT_FOOTER) && prompt.includes('超过约 25 行时将完整明细写进报告文件') &&
          prompt.includes('结论栏保留要点并注明"明细见报告"'), '只读提示词缺少结论格式或长明细规则');
      }],
      [40, '只读缺少或空白结论时保留完整汇报并告警', () => {
        for (const scenario of ['missing-conclusion', 'empty-conclusion']) {
          for (const args of [[], ['--full-output']]) {
            const result = run(scenario, args);
            exitIs(result, 0);
            check(result.stdout.startsWith('状态: 完成\n') && result.stdout.includes('验证: codex-stub → 完成\n') &&
              result.footer.includes('WARNING: 只读汇报缺少结论\n'), `${scenario} 未保留完整汇报或缺少 WARNING`);
            check(!result.log.includes('log-mode: summary'), '缺少结论时仍压缩日志');
          }
        }
      }],
      [41, '可写模式保持原汇报格式和单行摘要', () => {
        for (const scenario of ['missing-conclusion', 'empty-conclusion']) {
          const result = run(scenario, ['--write']);
          exitIs(result, 0);
          check(result.stdout.startsWith('完成 | 改动: 无 | 验证: codex-stub → 完成\n\n---\n') &&
            !result.stdout.includes('结论') && !result.footer.includes('WARNING'), '可写模式受结论要求影响');
          const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
          check(prompt.includes(REPORT_FOOTER) && !prompt.includes('结论:') &&
            prompt.includes('写了就在验证栏末尾注明"明细见报告"'), '可写模式提示词发生变化');
        }
      }],
      [42, '--no-claude 仍输出 LIMIT，文字解析和账号状态迁移', () => {
        const limitIs = (result) => {
          exitIs(result, 15);
          check(result.stdout.startsWith('LIMIT\n') && /^reason: Codex 用量限额，.+ 恢复/m.test(result.stdout) &&
            /^resets: \S+$/m.test(result.stdout), '未输出 LIMIT 块或恢复时间');
          check(result.record.status === 'limit' && result.record.fallback === false && !/^exec: .* "-p"/m.test(result.log),
            '限额时调用了 Claude');
        };
        const hit = run('limit');
        limitIs(hit);
        const until = limitState().resets_at * 1000;
        const expected = Date.now() + 2 * 3_600_000 + 60_000;
        check(Math.abs(until - expected) < 3 * 60_000, `冷却时间未取自提示: ${new Date(until).toISOString()}`);
        const cooled = run('complete', [], false, { preserveCooldown: true });
        limitIs(cooled);
        check(!/^exec: /m.test(cooled.log), '限额冷却期间仍启动了 Codex');
        const done = run('complete');
        const resumed = run('limit', ['--resume', done.record.log_id]);
        limitIs(resumed);
        check(resumed.stdout.includes(`resumed: ${done.record.log_id}`), '续跑的 LIMIT 缺少 resumed');
        const noTime = run('limit-notime');
        limitIs(noTime);
        const fallbackUntil = limitState().resets_at * 1000;
        check(Math.abs(fallbackUntil - (Date.now() + (config.limitCooldownMinutes ?? 60) * 60_000)) < 60_000,
          '无恢复时间时未按默认时长冷却');
        fs.rmSync(limitPath);
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        fs.writeFileSync(cooldownPath, JSON.stringify({ 'codex-usage-limit': new Date(Date.now() + 3600_000).toISOString(),
          [config.tiers.tier1.codex.model]: new Date(Date.now() + 60_000).toISOString() }));
        const migrated = run('complete', [], false, { preserveCooldown: true });
        limitIs(migrated);
        const cooldown = JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
        check(limitState().source === 'migration' && !Object.hasOwn(cooldown, LIMIT_KEY) &&
          Object.hasOwn(cooldown, config.tiers.tier1.codex.model), '迁移破坏了普通模型冷却');
      }],
      [43, '--claude 跳过 Codex 和限额冷却，直接交给 Claude', () => {
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        fs.mkdirSync(path.dirname(cooldownPath), { recursive: true });
        fs.writeFileSync(cooldownPath, JSON.stringify({ 'codex-usage-limit': new Date(Date.now() + 3_600_000).toISOString() }) + '\n');
        const result = run('complete', ['--claude'], true, { preserveCooldown: true });
        exitIs(result, 0);
        check(/^exec: .* "-p"/m.test(result.log) && !/^exec: [^"].* exec /m.test(result.log) && result.record.fallback === false,
          '--claude 未直接调用 Claude');
        const bad = spawnSync(process.execPath, [SCRIPT_PATH, 'tier1', '--claude', '--no-claude', '--cwd', repo],
          { env, cwd: home, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
        exitIs(bad, 2);
      }],
      [44, '会话元数据优先，忽略 premium、对话和其他 session，成功更新快照', () => {
        for (const [scenario, type] of [['limit-session', '5h'], ['limit-weekly', 'weekly'], ['limit-reached', '5h']]) {
          const result = run(scenario);
          exitIs(result, 15);
          const state = limitState();
          check(state.source === 'session' && state.type === type &&
            Object.hasOwn(state, 'last_checked_at') && Number.isFinite(Date.parse(state.detected_at)) &&
            Math.abs(state.resets_at - Date.now() / 1000 - (type === 'weekly' ? 604800 : 7200)) < 5,
            `${scenario} 的快照类型或恢复时间不符`);
          check(!fs.readFileSync(limitPath, 'utf8').includes('SELFTEST_PRIVATE_DIALOGUE'), '状态保存了对话内容');
        }
        const premium = run('premium-only');
        exitIs(premium, 15);
        check(limitState().source === 'text', '把 premium 空快照当作 codex');
        const healthy = run('metadata-healthy-error');
        exitIs(healthy, 10);
        check(limitState().type === null, '有效健康快照未优先于旧限额文字');
        const success = run('complete-snapshot');
        exitIs(success, 0);
        check(limitState().snapshot.primary.used_percent === 23 && limitState().type === null, '成功运行未更新快照');
      }],
      [45, '限额期间回退 Claude，5 分钟检查节流和 footer', () => {
        const state = seedLimit();
        appMode('limited', state.resets_at);
        const calls = appCalls().length;
        const result = run('complete', [], true, { preserveCooldown: true });
        exitIs(result, 0);
        check(result.record.executor === 'claude' && result.record.fallback && result.footer.includes('codex 5h 限额至') &&
          !result.log.includes(' exec '), '限额时未回退 Claude 或 footer 缺少原因');
        exitIs(run('complete', [], true, { preserveCooldown: true }), 0);
        check(appCalls().length === calls + 1 && limitState().query_available === true, '没有按 5 分钟节流额度查询');
      }],
      [46, '到点恢复、提前恢复和 resets_at 变化后使用 Codex', () => {
        seedLimit({ resets_at: Math.floor(Date.now() / 1000) - 1 });
        const calls = appCalls().length;
        const expired = run('complete', [], true, { preserveCooldown: true });
        exitIs(expired, 0);
        check(expired.record.executor === 'codex' && limitState().type === null && appCalls().length === calls, '到点未直接恢复');
        for (const mode of ['recovered', 'changed']) {
          const state = seedLimit();
          appMode(mode, mode === 'changed' ? state.resets_at + 1800 : state.resets_at);
          const result = run('complete', [], true, { preserveCooldown: true });
          exitIs(result, 0);
          check(result.record.executor === 'codex' && limitState().type === null, `${mode} 未恢复 Codex`);
        }
      }],
      [47, '接口不可用或字段不符，每 15 分钟用真实任务重试', () => {
        for (const mode of ['unavailable', 'malformed']) {
          const state = seedLimit();
          appMode(mode, state.resets_at);
          const result = run('complete', [], true, { preserveCooldown: true });
          exitIs(result, 0);
          check(result.record.executor === 'claude' && limitState().query_available === false, `${mode} 没有使用退路`);
          saveLimit({ ...limitState(), last_probe_at: new Date(Date.now() - 16 * 60_000).toISOString() });
          const retry = run('limit-session', [], true, { preserveCooldown: true });
          exitIs(retry, 0);
          check(retry.log.includes(' exec ') && retry.record.executor === 'claude', '到 15 分钟没有试 Codex 并立即回退');
          const wait = run('complete', [], true, { preserveCooldown: true });
          exitIs(wait, 0);
          check(!wait.log.includes(' exec '), '失败后未等待下一个 15 分钟');
          saveLimit({ ...limitState(), last_probe_at: new Date(Date.now() - 16 * 60_000).toISOString() });
          const recovered = run('complete', [], true, { preserveCooldown: true });
          exitIs(recovered, 0);
          check(recovered.record.executor === 'codex' && limitState().type === null, '真实任务成功后未清除限额');
        }
      }],
      [48, '运行中限额立即交给 Claude，并保留任务和部分改动提醒', () => {
        const result = run('limit-partial', ['--write'], true);
        exitIs(result, 0);
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(result.record.executor === 'claude' && result.record.fallback && result.log.includes(' exec ') &&
          prompt.includes('AGENT_ROUTE_SELFTEST:limit-partial') && prompt.includes('工作区可能已有上一个执行方的部分改动，先查看 git diff') &&
          fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8').includes('partial codex change'), '中途接手缺少任务、提醒或已有改动');
      }],
      [49, '--resume 跨执行方，新 Claude 会话继续跟随 Claude', () => {
        const original = run('complete');
        const state = seedLimit({ last_checked_at: new Date().toISOString(), query_available: true });
        const result = run('limit-session', ['--resume', original.record.log_id], true, { preserveCooldown: true });
        exitIs(result, 0);
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(result.record.executor === 'claude' && result.record.session !== original.record.session &&
          !result.log.includes('"--resume"') && prompt.includes('AGENT_ROUTE_SELFTEST:complete') &&
          prompt.includes('AGENT_ROUTE_SELFTEST:limit-session') && prompt.includes('新增要求'), '跨执行方未新开会话或丢失原任务');
        saveLimit({ ...state, resets_at: Math.floor(Date.now() / 1000) - 1 });
        const resumed = run('complete', ['--resume', result.record.log_id], true, { preserveCooldown: true });
        exitIs(resumed, 0);
        check(resumed.record.executor === 'claude' && resumed.record.session === result.record.session &&
          resumed.log.includes(`"--resume" "${result.record.session}"`) && !resumed.log.includes(' exec '), 'Claude 续跑没有跟随原执行方');
      }],
      [50, '两边受限输出 LIMIT，Claude exit 0/1 和无恢复时间', () => {
        for (const scenario of ['limit-both', 'limit-both-zero', 'limit-both-api']) {
          const result = run(scenario, [], true);
          exitIs(result, 15);
          check(result.stdout.startsWith('LIMIT\n') && result.stdout.includes('Codex 用量限额') &&
            result.stdout.includes('Claude 用量限额') && /^claude-resets: /m.test(result.stdout), '双限额缺少两边恢复时间');
          check(scenario === 'limit-both-api' ? result.stdout.includes('claude-resets: unknown') :
            /claude-resets: \d{4}-\d\d-\d\dT20:20:00\.000Z/.test(result.stdout), 'Claude 时间或未知时间解析不符');
        }
      }],
      [51, 'tier2 读写模型与 effort、monitor Claude 和 Codex 配置', () => {
        for (const [extra, expectedModel, expectedEffort] of [[[], config.tiers.tier2.claude.readOnlyModel, 'xhigh'],
          [['--write'], config.tiers.tier2.claude.model, 'medium'], [['--monitor'], config.monitorClaude.model, 'medium']]) {
          seedLimit({ last_checked_at: new Date().toISOString(), query_available: true });
          const tier2 = spawnSync(process.execPath, [SCRIPT_PATH, 'tier2', '--cwd', repo, ...extra],
            { env, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
          exitIs(tier2, 0);
          const row = history().at(-1);
          const log = fs.readFileSync(path.join(home, 'logs', `${row.log_id}.log`), 'utf8');
          check(log.includes(`"--model" "${expectedModel}" "--effort" "${expectedEffort}"`), 'tier2/monitor Claude 配置未生效');
        }
        const monitored = run('monitor', ['--monitor']);
        exitIs(monitored, 0);
        check(monitored.record.effort === 'xhigh', 'monitor Codex 未使用 xhigh');
      }],
      [52, 'status 显示窗口用量和路由，切换账号不会继承限额', () => {
        seedLimit();
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, encoding: 'utf8', timeout: 5000 });
        exitIs(status, 0);
        check(/codex 5h: 100% resets /.test(status.stdout) && /codex weekly: 3% resets /.test(status.stdout) &&
          status.stdout.includes('route: Claude'), 'status 未显示用量或路由');
        fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'another-account' } }));
        try {
          const other = run('complete', [], true, { preserveCooldown: true });
          exitIs(other, 0);
          check(other.record.executor === 'codex', '另一账号继承了限额');
        } finally {
          fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'selftest-account' } }));
        }
      }],
      [53, '并发状态写入不损坏且不会残留临时文件', async () => {
        fs.rmSync(limitPath, { force: true });
        const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
          const child = spawn(process.execPath, [SCRIPT_PATH, 'tier1', '--no-claude', '--cwd', repo], { env, stdio: ['pipe', 'ignore', 'pipe'] });
          let error = '';
          child.stderr.on('data', (chunk) => { error += chunk; });
          child.on('error', (value) => resolve({ error: value.message }));
          child.on('close', (code) => resolve({ code, error }));
          child.stdin.end('AGENT_ROUTE_SELFTEST:limit-session\n');
        })));
        check(results.every((result) => result.code === 15), `并发派发失败: ${JSON.stringify(results)}`);
        check(limitState().type === '5h' && Number.isFinite(limitState().resets_at) &&
          !fs.readdirSync(path.dirname(limitPath)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), '并发状态损坏或临时文件未清理');
      }],
      [54, '额度查询 15 秒超时退路，成功失败都结束 app-server', async () => {
        seedLimit();
        appMode('hang-stubborn');
        const started = Date.now();
        const result = run('complete', [], true, { preserveCooldown: true, timeout: 20_000 });
        exitIs(result, 0);
        check(Date.now() - started >= 15_000 && Date.now() - started < 19_000 &&
          result.record.executor === 'claude' && limitState().query_available === false, '15 秒超时未使用退路');
        await new Promise((resolve) => setTimeout(resolve, 100));
        check(appCalls().every(({ pid }) => {
          try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
        }), 'app-server 仍有残留进程');
      }],
      [55, '续跑失败后同 session 重试一次并成功', () => {
        const original = run('complete');
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        resetFailCount('codex-fail-1');
        const result = run('codex-fail-1', ['--resume', original.record.log_id], true, { rounds: 2 });
        exitIs(result, 0);
        const [failedTry, retry] = result.records;
        check(failedTry.status === 'error' && failedTry.attempt === 'resume' && retry.attempt === 'resume retry' &&
          result.record === retry && retry.session === original.record.session && retry.executor === 'codex' &&
          retry.fallback === false && retry.status === 'complete', 'history 未记录续跑失败和重试成功');
        check(result.log.includes('attempt: resume retry') && result.log.includes(`exec resume ${original.record.session} - `) &&
          !/^exec: .* "-p"/m.test(result.log) && result.footer.includes('step resume retry') &&
          result.footer.includes(`resumed ${original.record.log_id}`), '重试未沿用同一 session 或 footer 缺少步骤');
        const firstLog = fs.readFileSync(path.join(home, 'logs', `${failedTry.log_id}.log`), 'utf8');
        check(firstLog.includes('attempt failure: resume: codex 退出码 1') && firstLog.includes('simulated codex failure') &&
          !fs.existsSync(cooldownPath), '首次失败原因未入日志，或重试成功仍写了冷却');
        // 已有冷却时续跑照常重试并保持冷却不变。
        const saved = JSON.stringify({ [config.tiers.tier1.codex.model]: new Date(Date.now() + 60_000).toISOString() }) + '\n';
        fs.writeFileSync(cooldownPath, saved);
        resetFailCount('codex-fail-1');
        const cooled = run('codex-fail-1', ['--resume', original.record.log_id], true, { rounds: 2, preserveCooldown: true });
        exitIs(cooled, 0);
        check(cooled.record.attempt === 'resume retry' && fs.readFileSync(cooldownPath, 'utf8') === saved, '冷却期间续跑未重试或冷却被改写');
      }],
      [56, '续跑两次失败后新 Codex 线程成功，并携带原任务和部分改动提醒', () => {
        const original = run('complete', ['--write']);
        resetFailCount('codex-fail-2');
        const result = run('codex-fail-2', ['--resume', original.record.log_id, '--write'], true, { rounds: 3 });
        exitIs(result, 0);
        check(result.records.map((row) => row.attempt).join() === 'resume,resume retry,fresh attempt 1' &&
          result.record.executor === 'codex' && result.record.fallback === false && result.record.session !== original.record.session &&
          !result.log.includes(' resume ') && result.log.includes('exec: ') && result.footer.includes('step fresh attempt 1') &&
          !fs.existsSync(path.join(home, 'state', 'cooldown.json')), '新线程未完成或错误地续跑/写冷却');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('AGENT_ROUTE_SELFTEST:complete') && prompt.includes('AGENT_ROUTE_SELFTEST:codex-fail-2') &&
          prompt.includes('新增要求') && prompt.includes('工作区可能已有上一个执行方的部分改动，先查看 git diff。'),
          '新线程说明缺少原任务、新增要求或提醒');
        check(new Set(result.records.map((row) => row.log_id)).size === 3, '每次尝试应有独立日志');
      }],
      [57, '续跑两次加新线程两次失败，写冷却并由 Claude 新开执行', () => {
        const original = run('complete');
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        resetFailCount('codex-fail-4');
        const result = run('codex-fail-4', ['--resume', original.record.log_id], true, { rounds: 5 });
        exitIs(result, 0);
        check(result.records.map((row) => row.attempt).join() ===
          'resume,resume retry,fresh attempt 1,fresh attempt 2,claude fallback' &&
          result.records.slice(0, 4).every((row) => row.status === 'error' && row.executor === 'codex') &&
          result.record.executor === 'claude' && result.record.fallback === true && result.record.status === 'complete' &&
          result.record.session !== original.record.session && result.footer.includes('step claude fallback'),
          'history 未按顺序记录四次 Codex 失败和 Claude 完成');
        check(Date.parse(JSON.parse(fs.readFileSync(cooldownPath, 'utf8'))[config.tiers.tier1.codex.model]) > Date.now(),
          'Codex 全部失败后未写冷却');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(/^exec: .* "-p"/m.test(result.log) && !result.log.includes('"--resume"') &&
          prompt.includes('AGENT_ROUTE_SELFTEST:complete') && prompt.includes('AGENT_ROUTE_SELFTEST:codex-fail-4') &&
          prompt.includes('工作区可能已有上一个执行方的部分改动，先查看 git diff。'), 'Claude 未新开线程或说明缺少原任务和提醒');
        const failures = result.records.slice(0, 4).map((row) => fs.readFileSync(path.join(home, 'logs', `${row.log_id}.log`), 'utf8'));
        check(failures.every((text, i) => text.includes('attempt failure: ') && text.includes('codex 退出码 1')) &&
          failures[3].includes('attempt: fresh attempt 2'), '日志未逐次记录失败原因');
      }],
      [58, '续跑重试全部失败且 --no-claude 时输出 FALLBACK', () => {
        const original = run('complete');
        resetFailCount('codex-fail-4');
        const result = run('codex-fail-4', ['--resume', original.record.log_id], false, { rounds: 5 });
        exitIs(result, 10);
        check(result.stdout.startsWith('FALLBACK\n') && result.stdout.includes('attempt: claude fallback') &&
          result.record.status === 'fallback' && result.record.attempt === 'claude fallback' &&
          result.records.slice(0, 4).every((row) => row.status === 'error') &&
          !/^exec: .* "-p"/m.test(result.log), '--no-claude 未输出带步骤的 FALLBACK');
        check(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(home, 'state', 'cooldown.json'), 'utf8')), config.tiers.tier1.codex.model),
          'FALLBACK 前未写冷却');
        const prompt = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
        check(prompt.includes('AGENT_ROUTE_SELFTEST:complete') && prompt.includes('新增要求'), 'FALLBACK 的 prompt 文件未包含重建后的任务');
      }],
      [59, '找不到原任务时跳过新线程，Claude 无法接手则 ERROR，--no-claude 仍 FALLBACK', () => {
        for (const noClaudeMode of [false, true]) {
          const original = run('complete');
          fs.rmSync(path.join(home, 'logs', `${original.record.log_id}.prompt.md`), { force: true });
          resetFailCount('codex-fail-4');
          const result = run('codex-fail-4', ['--resume', original.record.log_id], !noClaudeMode, { rounds: 3 });
          exitIs(result, noClaudeMode ? 10 : 12);
          check(result.records.map((row) => row.attempt).join() === 'resume,resume retry,claude fallback' &&
            !result.log.includes('attempt: fresh attempt') && !/^exec: .* "-p"/m.test(result.log) &&
            (noClaudeMode ? result.stdout.startsWith('FALLBACK\n') : result.stdout.startsWith('ERROR\n') && result.stdout.includes('找不到原任务说明')) &&
            fs.readFileSync(path.join(home, 'logs', `${result.records[1].log_id}.log`), 'utf8').includes('rebuild failure'),
            `找不到原任务时的跳过或终止行为不符 (noClaude=${noClaudeMode})`);
        }
      }],
      [60, 'CC Switch 用例 1：设备指针优先，缺失和失效时只读回退 is_current', async () => {
        await resetRoutes();
        for (const pointer of ['device-codex', undefined, 'deleted-codex']) {
          deviceSettings({ currentProviderCodex: pointer, currentProviderClaude: pointer === 'device-codex' ? 'device-claude' : pointer });
          const before = routeSnapshot();
          const result = await resolveRoutes();
          check(result.codex.providerId === (pointer === 'device-codex' ? 'device-codex' : 'database-codex') &&
            result.claude.providerId === (pointer === 'device-codex' ? 'device-claude' : 'database-claude'), '设备指针与 is_current 顺序不符');
          check(result.codex.billingType === 'api' && result.claude.billingType === 'api', 'direct API 未识别');
          check(routeSnapshot() === before, '解析修改了 CC Switch 文件或创建了数据库文件');
        }
      }],
      [61, 'CC Switch 用例 2：proxy_route、附着、分离和无效 route', async () => {
        await resetRoutes();
        modeState({ mode: 'proxy', attached: true, proxy_route: 'proxy-codex' }, { mode: 'proxy', attached: true, proxy_route: 'proxy-claude' });
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml('http://127.0.0.1:15721/v1', 'PROXY_MANAGED'));
        writeJSON(path.join(home, '.claude', 'settings.json'), claudeSettings('http://127.0.0.1:15721', 'PROXY_MANAGED'));
        let result = await resolveRoutes();
        check(['codex', 'claude'].every((app) => result[app].providerId === `proxy-${app}` &&
          result[app].billingType === 'api' && result[app].actualRoute === 'proxy'), '代理路由没有优先于直连指针');
        deviceSettings({ currentProviderCodex: 'deleted-codex' });
        await databaseEdit((database) => database.exec("UPDATE providers SET is_current = 1 WHERE app_type = 'codex'"));
        result = await resolveRoutes();
        check(result.codex.providerId === 'proxy-codex' && result.codex.billingType === 'api', '有效 proxy_route 被失效直连指针或多条 is_current 阻挡');
        await databaseEdit((database) => database.exec("UPDATE providers SET is_current = CASE WHEN id = 'database-codex' THEN 1 ELSE 0 END WHERE app_type = 'codex'"));
        deviceSettings();
        modeState({ mode: 'proxy', attached: false, proxy_route: 'proxy-codex' }, { mode: 'proxy', attached: false, proxy_route: 'proxy-claude' });
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml());
        writeJSON(path.join(home, '.claude', 'settings.json'), claudeSettings());
        result = await resolveRoutes();
        check(['codex', 'claude'].every((app) => result[app].providerId === `device-${app}` &&
          result[app].selectedProviderId === `proxy-${app}` && result[app].actualRoute === 'direct' &&
          result[app].diagnostics.includes('proxy-detached')), '代理分离时未核对实际直连配置');
        modeState({ mode: 'proxy', attached: true, proxy_route: 'deleted-route' });
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml('http://127.0.0.1:15721/v1', 'PROXY_MANAGED'));
        result = await resolveRoutes();
        check(result.codex.providerId === 'device-codex' && result.codex.diagnostics.includes('proxy-route-invalid'), '失效代理路由未只读回退直连指针');
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml());
        result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('proxy-live-mismatch'), '代理附着与 live 不一致未阻止判定');
      }],
      [62, 'CC Switch 用例 2：未知 version、pending、Stack 和读取竞态返回 unknown', async () => {
        await resetRoutes();
        for (const [mode, version, diagnostic] of [[{}, 9, 'live-state-version-unsupported'],
          [{ pending: { op: 'switch' } }, 1, 'cc-switch-pending'], [{ stack: { enabled: true } }, 1, 'cc-switch-stack-unsupported']]) {
          modeState(mode, {}, version);
          const result = await resolveRoutes();
          check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes(diagnostic), `${diagnostic} 未显式阻止判定`);
        }
        modeState();
        const originalRead = fs.readFileSync;
        const target = path.join(deviceDir, 'settings.json');
        let reads = 0;
        try {
          fs.readFileSync = (file, ...args) => {
            const value = originalRead(file, ...args);
            if (file === target) { reads++; fs.appendFileSync(target, ' '); }
            return value;
          };
          const result = await resolveRoutes();
          check(reads === 2 && result.codex.billingType === 'unknown' && result.claude.billingType === 'unknown' &&
            result.codex.diagnostics.includes('cc-switch-read-race'), '持续切换未有限重读并失败');
        } finally { fs.readFileSync = originalRead; }
        reads = 0;
        try {
          fs.readFileSync = (file, ...args) => {
            const value = originalRead(file, ...args);
            if (file === target && reads++ === 0) fs.appendFileSync(target, ' ');
            return value;
          };
          const result = await resolveRoutes();
          check(result.codex.billingType === 'api' && reads === 2, '短暂读取竞态未通过重读恢复');
        } finally { fs.readFileSync = originalRead; }
      }],
      [63, 'CC Switch 用例 3：自有 bearer、保留 ChatGPT 登录和 requires_openai_auth 仍判 API', async () => {
        await resetRoutes();
        const result = await resolveRoutes();
        check(result.codex.providerId === 'device-codex' && result.codex.billingType === 'api', '残留官方登录被误当成当前计费类型');
        noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml(routeURL, 'different-key'));
        const mismatch = await resolveRoutes();
        check(mismatch.codex.billingType === 'unknown' && mismatch.codex.diagnostics.includes('provider-credentials-mismatch'), '同 endpoint 不同凭据未判为冲突');
        for (const credential of ['env_key = "FIXTURE_API_KEY"', 'auth = { command = "/never-execute-selftest-auth" }',
          'http_headers = { Authorization = "Bearer SELFTEST_PRIVATE_HEADER" }']) {
          const declared = `model_provider = "custom"\n[model_providers.custom]\nbase_url = ${JSON.stringify(routeURL)}\n${credential}\n`;
          fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), declared);
          await databaseEdit((database) => database.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?')
            .run(JSON.stringify({ config: declared, auth: { OPENAI_API_KEY: 'unused-row-key' } }), 'device-codex', 'codex'));
          const result = await resolveRoutes();
          check(result.codex.billingType === 'api' && result.codex.providerId === 'device-codex', '自有 env_key、auth 命令或 header 路径未识别');
          noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
        }
      }],
      [64, 'CC Switch 用例 4：官方 custom 镜像、官方 API key、证据不足及 profile', async () => {
        await resetRoutes();
        deviceSettings({ currentProviderCodex: 'official-codex', currentProviderClaude: 'official-claude' });
        const mirror = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://chatgpt.com/backend-api/codex"\nrequires_openai_auth = true\n';
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), mirror);
        writeJSON(path.join(home, '.claude', 'settings.json'), { env: {} });
        let result = await resolveRoutes();
        check(result.codex.billingType === 'subscription' && result.codex.providerId === 'official-codex' &&
          result.claude.billingType === 'unknown' && result.claude.diagnostics.includes('claude-login-unverified'), '官方镜像或未验证 Claude 登录判定不符');
        modeState({ mode: 'proxy', attached: true, proxy_route: 'official-codex' });
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml('http://127.0.0.1:15721/v1', 'PROXY_MANAGED'));
        result = await resolveRoutes();
        check(result.codex.billingType === 'subscription' && result.codex.providerId === 'official-codex', '代理占位凭据被误当官方上游 API 计费');
        modeState();
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'model_provider = "openai"\n');
        writeJSON(path.join(env.CODEX_HOME, 'auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: routeKey });
        result = await resolveRoutes();
        check(result.codex.billingType === 'api', '官方 API key 被误当订阅');
        writeJSON(path.join(env.CODEX_HOME, 'auth.json'), {});
        result = await resolveRoutes();
        check(result.codex.billingType === 'unknown', '没有登录证据时未返回 unknown');
        authFixture();
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'profile = "custom"\n' + mirror);
        result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('codex-profile-unsupported'), '未支持的 profile 被静默忽略');
      }],
      [65, 'CC Switch 用例 12：缺失/损坏数据库、非法 JSON/TOML、删除行和读取策略', async () => {
        for (const mutation of ['missing-db', 'broken-db', 'schema', 'settings-json', 'state-json', 'row-json', 'row-toml', 'deleted-row']) {
          await resetRoutes();
          if (mutation === 'missing-db') fs.unlinkSync(databasePath);
          if (mutation === 'broken-db') fs.writeFileSync(databasePath, 'SELFTEST_PRIVATE broken sqlite');
          if (mutation === 'schema') await databaseEdit((database) => database.exec('ALTER TABLE providers RENAME COLUMN meta TO unsupported_meta'));
          if (mutation === 'settings-json') fs.writeFileSync(path.join(deviceDir, 'settings.json'), '{"secret":"SELFTEST_PRIVATE');
          if (mutation === 'state-json') fs.writeFileSync(path.join(deviceDir, 'live-state.json'), '{"secret":"SELFTEST_PRIVATE');
          if (mutation === 'row-json') await databaseEdit((database) => database.prepare('UPDATE providers SET settings_config = ? WHERE app_type = ?').run('{"secret":"SELFTEST_PRIVATE', 'codex'));
          if (mutation === 'row-toml') await databaseEdit((database) => database.prepare('UPDATE providers SET settings_config = ? WHERE app_type = ?').run(JSON.stringify({ config: 'secret = "SELFTEST_PRIVATE', auth: {} }), 'codex'));
          if (mutation === 'deleted-row') await databaseEdit((database) => database.exec("DELETE FROM providers WHERE app_type = 'codex'"));
          const result = await resolveRoutes();
          check(result.codex.billingType === 'api' && result.codex.providerId === null && result.codex.source === 'live-config' &&
            result.codex.diagnostics.includes('using-live-config'), `${mutation} 未按 live-config 策略回退`);
          noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
          check(mutation !== 'missing-db' || !fs.existsSync(databasePath), '只读解析创建了缺失数据库');
        }
        routeConfig.ccSwitch.onReadError = 'stop';
        try {
          const result = await resolveRoutes();
          check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('cc-switch-read-stopped'), 'stop 策略仍回退');
        } finally { routeConfig.ccSwitch.onReadError = 'live-config'; }
        await resetRoutes();
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'key = "SELFTEST_PRIVATE');
        let result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('toml-invalid'), '非法 live TOML 未返回 unknown');
        noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"secret":"SELFTEST_PRIVATE');
        result = await resolveRoutes();
        check(result.claude.billingType === 'unknown' && result.claude.diagnostics.includes('json-invalid'), '非法 Claude JSON 未返回 unknown');
      }],
      [66, 'CC Switch 用例 12：锁住的数据库有界超时并安全回退', async () => {
        await resetRoutes();
        const code = `const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(databasePath)}); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setInterval(() => {}, 1000);`;
        const locker = spawn(process.execPath, ['-e', code], { env, cwd: home, stdio: ['ignore', 'pipe', 'ignore'] });
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture 数据库加锁超时')), 3000);
            locker.once('error', (error) => { clearTimeout(timer); reject(error); });
            locker.stdout.once('data', () => { clearTimeout(timer); resolve(); });
          });
          const started = Date.now();
          const result = await resolveRoutes();
          check(Date.now() - started < 2000 && result.codex.billingType === 'api' && result.codex.source === 'live-config' &&
            result.codex.diagnostics.includes('database-unreadable'), '锁住数据库未有界回退');
        } finally {
          locker.kill('SIGKILL');
          await new Promise((resolve) => locker.once('close', resolve));
        }
      }],
      [67, 'CC Switch 目录、环境覆盖与 live 一致性', async () => {
        await resetRoutes();
        deviceSettings({ codexConfigDir: path.join(home, 'custom-codex'), claudeConfigDir: path.join(home, 'custom-claude') });
        fs.mkdirSync(path.join(home, 'custom-codex'), { recursive: true });
        fs.copyFileSync(path.join(env.CODEX_HOME, 'config.toml'), path.join(home, 'custom-codex', 'config.toml'));
        fs.copyFileSync(path.join(env.CODEX_HOME, 'auth.json'), path.join(home, 'custom-codex', 'auth.json'));
        writeJSON(path.join(home, 'custom-claude', 'settings.json'), claudeSettings());
        let result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('codex-directory-conflict'), '显式 CODEX_HOME 冲突未报告');
        const customEnv = { ...env }; delete customEnv.CODEX_HOME;
        result = await resolveRoutes({ env: customEnv });
        check(result.codex.billingType === 'api' && result.codex.configDir === path.join(home, 'custom-codex') &&
          result.claude.configDir === path.join(home, 'custom-claude'), '设备自定义配置目录未解析');
        deviceSettings();
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml('https://mismatch.fixture.invalid/v1'));
        result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('provider-live-mismatch'), 'live endpoint 与服务商冲突未返回 unknown');
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), routeToml());
        result = await resolveRoutes({ env: { ...env, OPENAI_BASE_URL: 'https://environment.fixture.invalid' } });
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('codex-environment-conflict'), 'Codex 环境覆盖未报告');
        result = await resolveRoutes({ env: { ...env, ANTHROPIC_BASE_URL: 'https://parent.fixture.invalid', ANTHROPIC_AUTH_TOKEN: 'parent' } });
        check(result.claude.billingType === 'api' && result.claude.providerId === 'device-claude', '错误地将父进程 Claude 凭据视为子进程环境');
      }],
      [68, 'CC Switch 用例 14：隔离派发、安全日志/history、重新读取及 unknown 停止', async () => {
        await resetRoutes();
        fs.copyFileSync(databasePath, path.join(deviceDir, 'cc-switch.db'));
        const defaults = await resolveDispatchContext({ ccSwitch: { enabled: true } }, { home, env, cwd: repo });
        check(defaults.codex.providerId === 'device-codex' && defaults.claude.providerId === 'device-claude', '默认 CC Switch 目录未随隔离 HOME 解析');
        const originalRead = fs.readFileSync;
        try {
          fs.readFileSync = () => { throw new Error('集成关闭时不应读取服务商'); };
          const disabled = await resolveDispatchContext({ ccSwitch: { enabled: false } });
          check(disabled.enabled === false, '关闭集成时仍读取了服务商');
        } finally { fs.readFileSync = originalRead; }
        const previousConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(routeConfig));
        try {
          let result = run('complete');
          exitIs(result, 0);
          check(result.record.providers.codex.providerId === 'device-codex' && result.record.providers.codex.billingType === 'api' &&
            result.log.includes('providers: ') && result.log.includes('log-mode: summary'), '安全身份没有保留在摘要日志或 history 中');
          noRouteSecrets(result.log + JSON.stringify(result.record));
          deviceSettings({ currentProviderCodex: 'database-codex' });
          result = run('complete');
          exitIs(result, 0);
          check(result.record.providers.codex.providerId === 'database-codex', '每次新派发未重新解析选择');
          fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'model_provider = "openai"\n');
          writeJSON(path.join(env.CODEX_HOME, 'auth.json'), {});
          const calls = invocations();
          result = run('complete');
          exitIs(result, 12);
          check(result.stdout.startsWith('ERROR\n') && result.record.providers.codex.billingType === 'unknown' && invocations() === calls,
            '无法判定的路由仍调用了客户端');
          noRouteSecrets(result.stdout + result.stderr + result.log + JSON.stringify(result.record));
          await resetRoutes();
          fs.unlinkSync(databasePath);
          result = run('complete');
          exitIs(result, 0);
          check(result.record.providers.codex.source === 'live-config', '子进程未使用已确认的 live 回退策略');
          noRouteSecrets(result.stdout + result.stderr + result.log + JSON.stringify(result.record));
          const denied = spawnSync(process.execPath, [config.codexBin, 'app-server'], { cwd: home,
            env: { HOME: path.join(home, 'uninitialized'), PATH: env.PATH }, encoding: 'utf8', timeout: 5000 });
          check(denied.status === 2 && denied.stderr.includes('缺少隔离环境'), 'stub 缺少隔离证据时没有拒绝执行');
        } finally { fs.writeFileSync(path.join(home, 'config.json'), previousConfig); }
      }],
    ];
    scenarios.push(
      [69, 'CC Switch 用例 5：tier2 订阅 Luna/API Sol，tier1 和 effort 优先级保持', () => withRoutedFixture(async () => {
        const custom = structuredClone(routeConfig);
        custom.monitorEffort = 'high';
        custom.tiers.tier2.codex.effort = 'medium';
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(custom));
        for (const billing of ['subscription', 'api']) {
          if (billing === 'subscription') useSubscription(); else await useApi();
          for (const [tier, args, expectedEffort] of [
            ['tier1', [], config.tiers.tier1.codex.effort], ['tier2', [], 'medium'], ['tier2', ['--write'], 'medium'],
            ['tier2', ['--monitor'], 'high'], ['tier2', ['--effort', 'low'], 'low'],
            ['tier2', ['--monitor', '--effort', 'minimal'], 'minimal'],
          ]) {
            const result = run(args.includes('--monitor') ? 'monitor' : 'complete', args, false, { tier });
            exitIs(result, 0);
            const expectedModel = tier === 'tier2' && billing === 'api' ? config.tiers.tier2.codex.apiModel : config.tiers[tier].codex.model;
            const call = invocationRows().at(-1);
            check(result.record.model === expectedModel && result.record.effort === expectedEffort &&
              call.args[call.args.indexOf('-m') + 1] === expectedModel && call.args.includes(`model_reasoning_effort="${expectedEffort}"`),
              `${billing}/${tier}/${args.join(' ')} 的模型或 effort 不符`);
          }
        }
      })],
      [70, 'CC Switch 用例 6：真实 monitor-loop → tier2 --no-claude --monitor，忽略旧订阅限额', () => withRoutedFixture(async () => {
        seedLimit();
        const before = fs.readFileSync(limitPath, 'utf8');
        writeJSON(cooldownPath, { 'codex-usage-limit': new Date(Date.now() + 3600_000).toISOString(),
          [config.tiers.tier2.codex.apiModel]: new Date(Date.now() + 3600_000).toISOString() });
        const monitorBin = path.join(home, 'monitor-bin');
        fs.mkdirSync(monitorBin, { recursive: true });
        fs.mkdirSync(path.join(home, '.claude', 'agent-route', 'bin'), { recursive: true });
        fs.symlinkSync(SCRIPT_PATH, path.join(home, '.claude', 'agent-route', 'bin', 'agent-route'));
        fs.writeFileSync(path.join(monitorBin, 'osascript'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
        const command = path.join(monitorBin, 'command');
        fs.writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write('AGENT_ROUTE_SELFTEST:monitor\\n');\n`, { mode: 0o755 });
        const calls = appCalls().length;
        const result = spawnSync('/bin/bash', [path.join(path.dirname(SCRIPT_PATH), 'monitor-loop'), '--name', 'routing-selftest',
          '--interval', '0', '--cwd', repo, '--log', path.join(home, 'monitor.log'), '--max-iterations', '1', '--', command],
        { env: { ...env, PATH: `${monitorBin}${path.delimiter}${env.PATH}` }, cwd: repo, encoding: 'utf8', timeout: 10000 });
        check(!result.error, result.error?.message);
        exitIs(result, 0);
        const row = history().at(-1);
        check(!result.stdout && row.tier === 'tier2' && row.monitor && row.model === config.tiers.tier2.codex.apiModel &&
          row.effort === config.monitorEffort && fs.readFileSync(path.join(home, 'monitor.log'), 'utf8').includes('STATUS: OK') &&
          appCalls().length === calls && fs.readFileSync(limitPath, 'utf8') === before, 'monitor 调用链模型、额度或输出不符');
        check(Object.hasOwn(JSON.parse(fs.readFileSync(cooldownPath, 'utf8')), LIMIT_KEY), 'API monitor 迁移了旧订阅状态');
      })],
      [71, 'CC Switch 用例 7：订阅→API A→API B→订阅，限额/冷却和 endpoint 指纹隔离', () => withRoutedFixture(async () => {
        useSubscription();
        seedLimit();
        const before = fs.readFileSync(limitPath, 'utf8');
        exitIs(run('complete', [], false, { preserveCooldown: true }), 15);
        await useApi();
        exitIs(run('api-429', [], false, { preserveCooldown: true }), 15);
        await useApi('database-codex');
        exitIs(run('complete', [], false, { preserveCooldown: true }), 0);
        await useApi();
        const calls = invocationRows().length;
        exitIs(run('complete', [], false, { preserveCooldown: true }), 15);
        check(invocationRows().length === calls, 'API A 没有保持自己的被动限额');
        const otherModel = structuredClone(routeConfig);
        otherModel.tiers.tier2.codex.apiModel = 'fixture-other-api-model';
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(otherModel));
        exitIs(run('complete', [], false, { preserveCooldown: true, tier: 'tier2' }), 0);
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(routeConfig));
        await useApi('device-codex', 'https://edited.fixture.invalid/v1');
        exitIs(run('complete', [], false, { preserveCooldown: true }), 0);
        useSubscription();
        exitIs(run('complete', [], false, { preserveCooldown: true }), 15);
        check(fs.readFileSync(limitPath, 'utf8') === before, 'API 切换改写了订阅账号状态');
        fs.rmSync(limitPath);
        fs.rmSync(providerLimitPath);
        exitIs(run('failure', [], false, { preserveCooldown: true }), 10);
        await useApi();
        exitIs(run('complete', [], false, { preserveCooldown: true }), 0);
        exitIs(run('failure', [], false, { preserveCooldown: true }), 10);
        await useApi('database-codex');
        exitIs(run('complete', [], false, { preserveCooldown: true }), 0);
        await useApi();
        exitIs(run('complete', [], false, { preserveCooldown: true }), 10);
        await useApi('device-codex', 'https://edited.fixture.invalid/v1');
        exitIs(run('complete', [], false, { preserveCooldown: true }), 0);
        useSubscription();
        exitIs(run('complete', [], false, { preserveCooldown: true }), 10);
        const keys = Object.keys(JSON.parse(fs.readFileSync(cooldownPath, 'utf8')));
        check(keys.length === 2 && keys.every((key) => key.startsWith('codex:')), '失败冷却未按 app/provider/model 隔离');
        noRouteSecrets(fs.readFileSync(cooldownPath, 'utf8'));
      })],
      [72, 'CC Switch 用例 8：API 成功/异常 session 快照不查询、扫描或改写订阅状态', () => withRoutedFixture(async () => {
        seedLimit({ query_available: true });
        const before = fs.readFileSync(limitPath, 'utf8');
        const calls = appCalls().length;
        const scanMarker = path.join(home, 'session-scan');
        const guard = path.join(home, 'session-scan-guard.mjs');
        fs.writeFileSync(guard, `import fs from 'node:fs';\nconst original = fs.readdirSync;\nfs.readdirSync = function(file, ...args) {\n` +
          `if (file === ${JSON.stringify(path.join(env.CODEX_HOME, 'sessions'))}) fs.writeFileSync(${JSON.stringify(scanMarker)}, 'scanned');\n` +
          `return original.call(this, file, ...args);\n};\n`);
        for (const [scenario, code] of [['complete', 0], ['api-complete-snapshot', 0], ['api-429-snapshot', 15]]) {
          const result = run(scenario, [], false, { preserveCooldown: true, nodeArgs: ['--import', guard] });
          exitIs(result, code);
          check(fs.readFileSync(limitPath, 'utf8') === before && appCalls().length === calls && !fs.existsSync(scanMarker),
            `${scenario} 读取/改写了订阅额度或扫描了 session 快照`);
        }
        check(Object.values(providerStates()).every((state) => !state || !Object.hasOwn(state, 'query_available') && !Object.hasOwn(state, 'snapshot')),
          'API 状态含订阅 query_available/snapshot');
        noRouteSecrets(fs.readFileSync(providerLimitPath, 'utf8'));
      })],
      [73, 'CC Switch 用例 9：429/余额被动限额，401/模型/网络错误普通冷却，status/LIMIT 区分模式', () => withRoutedFixture(async () => {
        for (const [scenario, type, seconds, resetSource] of [
          ['api-429', 'rate-limit', 120, 'retry-after'], ['api-429-date', 'rate-limit', 180, 'retry-after'],
          ['api-429-reset', 'rate-limit', 240, 'reset'], ['api-quota', 'quota', (config.limitCooldownMinutes ?? 60) * 60, 'fallback'],
          ['api-401', null], ['api-model', null], ['api-network', null],
        ]) {
          fs.rmSync(providerLimitPath, { force: true });
          fs.rmSync(cooldownPath, { force: true });
          seedLimit();
          const before = fs.readFileSync(limitPath, 'utf8');
          const result = run(scenario, [], false, { preserveCooldown: true });
          exitIs(result, type ? 15 : 10);
          const states = Object.values(providerStates()).filter(Boolean);
          check(fs.readFileSync(limitPath, 'utf8') === before, `${scenario} 改写了订阅状态`);
          if (type) {
            check(states.length === 1 && states[0].type === type && states[0].reset_source === resetSource &&
              Math.abs(states[0].resets_at - Date.now() / 1000 - seconds) < 5 && result.stdout.includes('Codex API 服务商限额') &&
              !result.stdout.includes('Codex 用量限额') && !fs.existsSync(cooldownPath), `${scenario} 被动状态或 LIMIT 不符`);
          } else check(states.length === 0 && Object.keys(JSON.parse(fs.readFileSync(cooldownPath, 'utf8'))).length === 1,
            `${scenario} 被误当限额或未写普通冷却`);
        }
        fs.rmSync(cooldownPath, { force: true });
        const dual = run('api-limit-both', [], true, { preserveCooldown: true });
        exitIs(dual, 15);
        check(dual.stdout.includes('Codex API 服务商限额') && dual.stdout.includes('Claude 用量限额'), '双限额未复用 API 服务商状态');
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
        exitIs(status, 0);
        check(status.stdout.includes('codex provider: Fixture codex (device-codex); mode: direct; billing: api') &&
          status.stdout.includes('claude provider: Fixture claude') && status.stdout.includes('subscription quota: not applicable (API)') &&
          status.stdout.includes(`codex tier2 model: ${config.tiers.tier2.codex.apiModel}`) && status.stdout.includes('API 服务商 rate-limit') &&
          !status.stdout.includes('codex 5h:') && !status.stdout.includes('codex weekly:'), 'API status 仍显示订阅窗口或缺少模型/服务商限额');
        noRouteSecrets(status.stdout + status.stderr);
        const clear = spawnSync(process.execPath, [SCRIPT_PATH, 'clear-cooldown'], { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
        exitIs(clear, 0);
        check(limitState().type === '5h' && Object.values(providerStates()).every((state) => !state), 'API clear-cooldown 清除了订阅或未清本服务商状态');
        const unrelated = run('limit-both', ['--claude'], true, { preserveCooldown: true });
        exitIs(unrelated, 12);
        check(unrelated.stdout.startsWith('ERROR\n') && !unrelated.stdout.includes('Codex 用量限额'), 'Claude 受限误读了旧订阅状态');
        fs.rmSync(providerLimitPath, { force: true });
        exitIs(run('api-429', [], false, { preserveCooldown: true }), 15);
        const states = providerStates();
        for (const state of Object.values(states)) if (state) state.resets_at = Math.floor(Date.now() / 1000) - 1;
        writeJSON(providerLimitPath, { providers: states });
        const recovered = run('complete', [], false, { preserveCooldown: true });
        exitIs(recovered, 0);
        check(Object.values(providerStates()).every((state) => !state) && limitState().type === '5h', 'API 到点后未恢复或清除了订阅状态');
      })],
      [74, 'CC Switch 用例 10：订阅原有查询/探测/恢复/no-claude/双限额与并发写入保持', () => withRoutedFixture(async () => {
        useSubscription();
        for (const mode of ['limited', 'unavailable', 'recovered']) {
          const state = seedLimit();
          appMode(mode, state.resets_at);
          const calls = appCalls().length;
          const result = run('complete', [], true, { preserveCooldown: true });
          exitIs(result, 0);
          check(appCalls().length === calls + 1 && result.record.executor === (mode === 'recovered' ? 'codex' : 'claude'), `${mode} 订阅路由不符`);
          exitIs(run('complete', [], true, { preserveCooldown: true }), 0);
          check(appCalls().length === calls + 1, '订阅 5 分钟查询节流失效');
          if (mode === 'unavailable') {
            saveLimit({ ...limitState(), last_probe_at: new Date(Date.now() - 16 * 60_000).toISOString() });
            const probe = run('complete', [], true, { preserveCooldown: true });
            exitIs(probe, 0);
            check(probe.record.executor === 'codex' && limitState().type === null, '订阅 15 分钟探测或恢复失效');
          }
        }
        seedLimit();
        const calls = appCalls().length;
        exitIs(run('complete', [], false, { preserveCooldown: true }), 15);
        check(appCalls().length === calls, '--no-claude 主动查询了订阅额度');
        exitIs(run('limit-both', [], true), 15);
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
        exitIs(status, 0);
        check(status.stdout.includes('billing: subscription') && status.stdout.includes('codex 5h:') &&
          status.stdout.includes(`codex tier2 model: ${config.tiers.tier2.codex.model}`), '订阅 status 缺少窗口或使用了 API 模型');
        for (const billing of ['subscription', 'api']) {
          if (billing === 'api') await useApi();
          fs.rmSync(limitPath, { force: true });
          fs.rmSync(providerLimitPath, { force: true });
          const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
            const child = spawn(process.execPath, [SCRIPT_PATH, 'tier1', '--no-claude', '--cwd', repo], { env, stdio: ['pipe', 'ignore', 'pipe'] });
            let error = '';
            child.stderr.on('data', (chunk) => { error += chunk; });
            child.on('error', (value) => resolve({ error: value.message }));
            child.on('close', (code) => resolve({ code, error }));
            child.stdin.end(`AGENT_ROUTE_SELFTEST:${billing === 'api' ? 'api-429' : 'limit-session'}\n`);
          })));
          check(results.every((result) => result.code === 15), `${billing} 并发写入失败: ${JSON.stringify(results)}`);
          check(billing === 'api' ? Object.values(providerStates()).filter(Boolean).length === 1 && !fs.existsSync(limitPath) : limitState().type === '5h',
            `${billing} 并发状态不符`);
          check(!fs.readdirSync(path.join(home, 'state')).some((name) => /\.(?:lock|tmp)$/.test(name)), `${billing} 并发写入残留锁或临时文件`);
        }
      })],
    );
    scenarios.push(
      [75, 'CC Switch 用例 11：Claude API 别名、family 映射、agent inherit、effort 与 monitor', () => withRoutedFixture(async () => {
        const agents = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
        for (const [tier, write, model, effective, effort] of [
          ['tier1', false, 'sonnet', 'fixture-sonnet', 'high'], ['tier1', true, 'sonnet', 'fixture-sonnet', 'high'],
          ['tier2', false, 'haiku', 'fixture-haiku', 'xhigh'], ['tier2', true, 'haiku', 'fixture-haiku', 'medium'],
        ]) {
          const result = run('complete', ['--claude', ...(write ? ['--write'] : []), '--effort', 'low'], true, { tier });
          exitIs(result, 0);
          const call = claudeCalls().at(-1);
          check(call.model === model && call.effectiveModel === effective && call.effort === effort,
            `${tier} write=${write} 模型映射或 effort 不符`);
          check(JSON.stringify(call.agent) === JSON.stringify({ ...agents[tier], model: 'inherit' }), 'agent 正常内容发生变化');
          check(call.customConfigDir === null, '默认目录被强制传入，改变了 .claude.json 位置');
        }
        env.AGENT_ROUTE_FORCE_CODEX_FAIL = '1';
        try {
          const result = run('monitor', ['--monitor'], true, { tier: 'tier1' });
          exitIs(result, 0);
          const call = claudeCalls().at(-1);
          check(call.model === 'haiku' && call.effectiveModel === 'fixture-haiku' && call.effort === 'medium', 'monitor Claude 模型或 effort 不符');
        } finally { env.AGENT_ROUTE_FORCE_CODEX_FAIL = '0'; }
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, cwd: repo, encoding: 'utf8', timeout: dispatchTimeout });
        check(status.status === 0 && status.stdout.includes('claude weekly: not applicable (API)') &&
          status.stdout.includes('claude tier1 model: sonnet') && status.stdout.includes('claude tier2 model: haiku'), 'status Claude API 信息不符');
      })],
      [76, 'CC Switch 用例 11：Claude 自定义目录与父环境隔离，官方订阅保留固定模型', () => withRoutedFixture(async () => {
        const custom = path.join(home, 'custom-claude-b3');
        deviceSettings({ claudeConfigDir: custom });
        writeJSON(path.join(custom, 'settings.json'), claudeSettings());
        env.ANTHROPIC_API_KEY = 'SELFTEST_PRIVATE_PARENT';
        env.ANTHROPIC_BASE_URL = 'https://parent.fixture.invalid';
        env.CLAUDE_CONFIG_DIR = path.join(home, 'must-not-use');
        try {
          const result = run('complete', ['--claude'], true);
          exitIs(result, 0);
          const call = claudeCalls().at(-1);
          check(call.configDir === custom && call.customConfigDir === custom && call.effectiveModel === 'fixture-sonnet', '自定义目录没有加载 family 映射');
          check(!call.envKeys.some((key) => /^(ANTHROPIC_|CLAUDE_CODE_|CODEX_|AGENT_ROUTE_)/.test(key) && key !== 'AGENT_ROUTE_DEPTH'), '父环境控制变量泄漏');
        } finally {
          delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL;
          env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
        }
        useClaudeSubscription(79);
        for (const tier of ['tier1', 'tier2']) {
          const result = run('complete', ['--claude'], true, { tier });
          exitIs(result, 0);
          const call = claudeCalls().at(-1);
          check(result.record.providers.claude.billingType === 'subscription' && call.model === routeConfig.tiers[tier].claude.model &&
            call.effort === (routeConfig.tiers[tier].claude.readOnlyEffort ?? routeConfig.tiers[tier].claude.effort), '官方模型或只读 effort 被改动');
        }
        deviceSettings({ currentProviderClaude: 'official-claude', claudeConfigDir: custom });
        writeJSON(path.join(custom, 'settings.json'), { env: {} });
        claudeAccount(80, {}, custom);
        const count = claudeCalls().length;
        const blocked = run('complete', ['--claude'], true);
        exitIs(blocked, 12);
        check(claudeCalls().length === count && blocked.stdout.includes('80%'), '自定义目录周额度未生效');
        writeJSON(path.join(home, 'stub-claude-auth.json'), { loggedIn: true, authMethod: 'api_key' });
        const unresolved = run('complete', ['--claude'], true);
        exitIs(unresolved, 12);
        check(unresolved.record.providers.claude.billingType === 'unknown' && claudeCalls().length === count, 'auth status 的非订阅认证被当作订阅');
        deviceSettings({ currentProviderClaude: 'official-claude' });
        writeJSON(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_API_KEY: routeKey } });
        const officialApi = run('complete', ['--claude'], true);
        exitIs(officialApi, 0);
        check(officialApi.record.providers.claude.billingType === 'api' && claudeCalls().at(-1).model === 'sonnet', '官方 API key 错用了订阅模型');
      })],
      [77, 'Claude 周额度：阈值边界、冷却持久化、到点恢复与账号隔离', () => withRoutedFixture(async () => {
        useClaudeSubscription(79);
        const beforeTimeout = claudeCalls().length;
        writeJSON(path.join(home, 'stub-claude-auth.json'), { loggedIn: true, authMethod: 'claude.ai', delayMs: 6000 });
        try {
          const timedOut = run('complete', ['--claude'], true);
          exitIs(timedOut, 12);
          check(timedOut.record.providers.claude.billingType === 'unknown' && claudeCalls().length === beforeTimeout,
            '认证超时后仍按订阅调用 Claude');
        } finally {
          writeJSON(path.join(home, 'stub-claude-auth.json'), { loggedIn: true, authMethod: 'claude.ai' });
        }
        exitIs(run('complete', ['--claude'], true), 0);
        const quotaFile = path.join(home, 'state', 'claude-limit.json');
        let count = claudeCalls().length;
        for (const percent of [80, 91]) {
          claudeAccount(percent);
          const blocked = run('complete', ['--claude'], true);
          exitIs(blocked, 12);
          check(claudeCalls().length === count && blocked.stdout.includes(`${percent}%`) && blocked.stdout.includes('冷却至'), '达到阈值仍调用 Claude');
        }
        exitIs(run('complete', ['--write']), 0); // Claude 冷却不改变 Codex 优先。
        exitIs(run('api-429', ['--write']), 15);
        const dual = run('complete', ['--write'], true, { preserveCooldown: true });
        exitIs(dual, 15);
        check(dual.stdout.includes('Codex API 服务商限额') && dual.stdout.includes('Claude 用量限额') && claudeCalls().length === count,
          'Claude 周额度冷却没有挡住 Codex 受限后的 fallback');
        const saved = fs.readFileSync(quotaFile, 'utf8');
        noRouteSecrets(saved);
        fs.rmSync(path.join(home, '.claude.json'));
        exitIs(run('complete', ['--claude'], true), 0); // 无法确认账号时不复用另一个账号的冷却。
        count++;
        writeJSON(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'SELFTEST_PRIVATE_CLAUDE_ACCOUNT' } });
        exitIs(run('complete', ['--claude'], true), 12);
        check(claudeCalls().length === count, '缓存消失后没有保持同账号冷却');
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, cwd: repo, encoding: 'utf8', timeout: dispatchTimeout });
        check(status.status === 0 && status.stdout.includes('claude weekly: 91%') &&
          status.stdout.includes('claude weekly threshold: 80%; cooldown: until'), 'status 未显示周额度冷却');
        writeJSON(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'SELFTEST_PRIVATE_OTHER_ACCOUNT' } });
        exitIs(run('complete', ['--claude'], true), 0);
        const states = JSON.parse(saved);
        for (const state of Object.values(states.accounts)) state.resets_at = Math.floor(Date.now() / 1000) - 1;
        writeJSON(quotaFile, states);
        writeJSON(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'SELFTEST_PRIVATE_CLAUDE_ACCOUNT' } });
        exitIs(run('complete', ['--claude'], true), 0);
        check(Object.values(JSON.parse(fs.readFileSync(quotaFile, 'utf8')).accounts).every((state) => !state), '过期冷却未清除');
        claudeAccount(91);
        exitIs(run('complete', ['--claude'], true), 12);
        claudeAccount(20);
        exitIs(run('complete', ['--claude'], true), 0);
      })],
      [78, 'Claude 周额度：缺失/损坏/过期数据退回被动检测，API 不使用订阅缓存', () => withRoutedFixture(async () => {
        useClaudeSubscription();
        for (const changes of [null, { fetchedAtMs: Date.now() - 3_600_001 }, { fetchedAtMs: Date.now() + 60_000 },
          { accountUuid: 'SELFTEST_PRIVATE_OTHER_ACCOUNT' }, { utilization: { seven_day: null } },
          { utilization: { seven_day: { utilization: '91', resets_at: new Date(Date.now() + 7200_000).toISOString() } } },
          { utilization: { seven_day: { utilization: 91, resets_at: new Date(Date.now() - 1000).toISOString() } } }]) {
          if (changes) claudeAccount(91, changes); else fs.rmSync(path.join(home, '.claude.json'), { force: true });
          exitIs(run('complete', ['--claude'], true), 0);
        }
        fs.writeFileSync(path.join(home, '.claude.json'), '{"secret":"SELFTEST_PRIVATE');
        exitIs(run('complete', ['--claude'], true), 0);
        const passive = run('limit-both', ['--claude'], true);
        exitIs(passive, 12);
        check(passive.stdout.includes('Claude 用量限额'), '周额度不可读时丢失了被动限额检测');
        claudeAccount(91);
        exitIs(run('complete', ['--claude'], true), 12);
        deviceSettings();
        writeJSON(path.join(home, '.claude', 'settings.json'), claudeSettings());
        exitIs(run('complete', ['--claude'], true), 0);
        const changedConfig = structuredClone(routeConfig);
        changedConfig.claudeWeeklyThreshold = 95;
        writeJSON(path.join(home, 'config.json'), changedConfig);
        useClaudeSubscription(91);
        exitIs(run('complete', ['--claude'], true), 0);
        changedConfig.claudeWeeklyThreshold = 0;
        writeJSON(path.join(home, 'config.json'), changedConfig);
        claudeAccount(0);
        exitIs(run('complete', ['--claude'], true), 12);
      })],
      [79, 'CC Switch 用例 13：Codex 续跑同服务商继续，变更服务商或 endpoint 后重建并记录', () => withRoutedFixture(async () => {
        let first = run('complete', ['--write']);
        exitIs(first, 0);
        const same = run('complete', ['--write', '--resume', first.record.log_id]);
        exitIs(same, 0);
        check(same.record.session === first.record.session && !same.record.provider_change && invocationRows().at(-1).args[1] === 'resume', '同服务商没有继续原会话');
        for (const [id, endpoint] of [['database-codex', routeURL], ['database-codex', 'https://edited.fixture.invalid/v1']]) {
          await useApi(id, endpoint);
          const result = run('complete', ['--write', '--resume', first.record.log_id]);
          exitIs(result, 0);
          check(result.record.session !== first.record.session && result.record.provider_change?.action === 'rebuild' &&
            invocationRows().at(-1).args[1] !== 'resume', '服务商变更仍续跑旧会话');
          check(result.log.includes('provider-change: ') && result.log.includes('log-mode: summary') &&
            result.stdout.includes('provider changed (codex); rebuild'), '服务商变更未保留在摘要日志/history/stdout');
          const task = fs.readFileSync(path.join(home, 'logs', `${result.record.log_id}.prompt.md`), 'utf8');
          check(task.includes('新增要求：') && task.match(/AGENT_ROUTE_SELFTEST:complete/g)?.length >= 2, '新线程未携带原任务和新增要求');
          noRouteSecrets(JSON.stringify(result.record));
          first = result;
        }
        await useApi('device-codex');
        fs.rmSync(path.join(home, 'logs', `${first.record.log_id}.prompt.md`));
        // 删除整条已保存任务链，不能凭 session UUID 默默串用旧上下文。
        for (const entry of history()) fs.rmSync(path.join(home, 'logs', `${entry.log_id}.prompt.md`), { force: true });
        const count = invocations();
        const missing = run('complete', ['--resume', first.record.session, '--write']);
        exitIs(missing, 12);
        check(invocations() === count && missing.record.provider_change.action === 'stop', '原任务丢失仍启动新线程');
      })],
      [80, 'CC Switch 用例 13：Claude 续跑变更服务商/计费/配置目录后重建，未知路由停止', () => withRoutedFixture(async () => {
        const first = run('complete', ['--claude', '--write'], true);
        exitIs(first, 0);
        const same = run('complete', ['--resume', first.record.log_id, '--write'], true);
        exitIs(same, 0);
        check(same.record.session === first.record.session && claudeCalls().at(-1).session === first.record.session, 'Claude 同服务商没有继续原会话');
        fs.writeFileSync(historyPath, history().filter((row) => row.log_id !== first.record.log_id).map((row) => JSON.stringify(row)).join('\n') + '\n');
        const fromLog = run('complete', ['--resume', first.record.log_id, '--write'], true);
        exitIs(fromLog, 0);
        check(fromLog.record.executor === 'claude' && fromLog.record.session === first.record.session && !fromLog.record.provider_change,
          '从日志恢复丢失了服务商或执行方身份');
        deviceSettings({ currentProviderClaude: 'database-claude' });
        const changed = run('complete', ['--resume', first.record.log_id, '--write'], true);
        exitIs(changed, 0);
        check(changed.record.provider_change?.app === 'claude' && changed.record.session !== first.record.session &&
          claudeCalls().at(-1).session === null && changed.stdout.includes('provider changed (claude); rebuild'), 'Claude 服务商变更未重建或记录');
        useClaudeSubscription();
        const subscribed = run('complete', ['--resume', changed.record.log_id, '--write'], true);
        exitIs(subscribed, 0);
        check(subscribed.record.providers.claude.billingType === 'subscription' && claudeCalls().at(-1).session === null &&
          claudeCalls().at(-1).model === routeConfig.tiers.tier1.claude.model, '订阅切换没有使用固定模型和新会话');
        const custom = path.join(home, 'resumed-claude-b3');
        deviceSettings({ currentProviderClaude: 'official-claude', claudeConfigDir: custom });
        writeJSON(path.join(custom, 'settings.json'), { env: {} });
        const relocated = run('complete', ['--resume', subscribed.record.log_id, '--write'], true);
        exitIs(relocated, 0);
        check(relocated.record.provider_change && claudeCalls().at(-1).session === null && claudeCalls().at(-1).configDir === custom,
          '配置目录变更仍传旧 session');
        writeJSON(path.join(home, 'stub-claude-auth.json'), { loggedIn: false, authMethod: 'none' });
        const count = claudeCalls().length;
        const unknown = run('complete', ['--resume', relocated.record.log_id, '--write'], true);
        exitIs(unknown, 12);
        check(claudeCalls().length === count && unknown.record.providers.claude.billingType === 'unknown' &&
          unknown.record.provider_change.action === 'stop', '未知路由仍启动 Claude 模型');
        fs.writeFileSync(historyPath, history().filter((row) => row.log_id !== changed.record.log_id).map((row) => JSON.stringify(row)).join('\n') + '\n');
        const backfill = spawnSync(process.execPath, [SCRIPT_PATH, 'stats'], { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
        const recovered = history().find((row) => row.log_id === changed.record.log_id);
        check(backfill.status === 0 && recovered?.provider_change?.action === 'rebuild' && recovered.executor === 'claude' &&
          recovered.providers.claude.providerId === 'database-claude', '摘要日志回填丢失服务商变更或实际执行方');
      })],
    );
    scenarios.push(
      [81, 'Codex 官方订阅：CC Switch 无 base_url 的 custom 镜像', () => withRoutedFixture(async () => {
        useSubscription();
        deviceSettings({ currentProviderCodex: 'official-codex', unifyCodexSessionHistory: true });
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), officialMirror);
        const before = routeSnapshot();
        const result = await resolveRoutes();
        check(result.codex.billingType === 'subscription' && result.codex.providerId === 'official-codex' &&
          result.codex.diagnostics.length === 0, '真实 OfficialMirror 被误判为 unknown');
        const status = spawnSync(process.execPath, [SCRIPT_PATH, 'status'], { env, cwd: repo, encoding: 'utf8', timeout: 5000 });
        check(status.status === 0 && /codex provider: .*billing: subscription/.test(status.stdout), 'status 未识别官方镜像订阅');
        check(routeSnapshot() === before, '官方镜像判定修改了 CC Switch 数据');
        noRouteSecrets(status.stdout + status.stderr + JSON.stringify(safeRouteContext(result.codex)));
      })],
      [82, 'Codex 官方订阅：原生 openai 形态和休眠 provider', async () => {
        await resetRoutes();
        useSubscription();
        for (const selector of ['', 'model_provider = "openai"\n']) {
          fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), selector + routeToml().slice(routeToml().indexOf('[model_providers.')));
          const result = await resolveRoutes();
          check(result.codex.billingType === 'subscription' && result.codex.providerId === 'official-codex' &&
            result.codex.diagnostics.length === 0, '原生官方路由或休眠表判定不符');
          noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
        }
      }],
      [83, 'Codex 官方 API key：原生与 custom 镜像均优先于 ChatGPT 登录', async () => {
        await resetRoutes();
        useSubscription();
        for (const config of ['model_provider = "openai"\n', officialMirror]) {
          fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), config);
          for (const source of ['auth', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
            authFixture();
            const apiEnv = { ...env };
            if (source === 'auth') {
              const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8'));
              auth.OPENAI_API_KEY = routeKey;
              writeJSON(path.join(env.CODEX_HOME, 'auth.json'), auth);
            } else apiEnv[source] = routeKey;
            const result = await resolveRoutes({ env: apiEnv });
            check(result.codex.billingType === 'api' && result.codex.providerId === 'official-codex', `${source} 未覆盖官方订阅登录`);
            noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
          }
        }
      }],
      [84, 'Codex 订阅证据不足：缺登录材料、官方服务商或后端时给出具体诊断', async () => {
        await resetRoutes();
        useSubscription();
        for (const config of ['model_provider = "openai"\n', officialMirror]) {
          for (const [missing, diagnostic] of [
            ['file', 'codex-chatgpt-access-token-missing'], ['access_token', 'codex-chatgpt-access-token-missing'],
            ['refresh_token', 'codex-chatgpt-refresh-token-missing'], ['auth_mode', 'codex-chatgpt-auth-mode-unverified'],
            ['store', 'codex-auth-store-unverified']]) {
            authFixture();
            fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), (missing === 'store' ? 'cli_auth_credentials_store = "keyring"\n' : '') + config);
            const authPath = path.join(env.CODEX_HOME, 'auth.json');
            if (missing === 'file') fs.unlinkSync(authPath);
            else if (missing !== 'store') {
              const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
              if (missing === 'auth_mode') delete auth.auth_mode;
              else delete auth.tokens[missing];
              writeJSON(authPath, auth);
            }
            const result = await resolveRoutes();
            check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes(diagnostic) &&
              !result.codex.diagnostics.includes('billing-unverified'), `${missing} 缺失时未给出具体诊断`);
            noRouteSecrets(JSON.stringify(safeRouteContext(result.codex)));
          }
        }
        authFixture();
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), officialMirror);
        await databaseEdit((database) => database.prepare('UPDATE providers SET category = ? WHERE id = ? AND app_type = ?')
          .run('third_party', 'official-codex', 'codex'));
        let result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('codex-official-provider-unverified'),
          '仅凭 custom 镜像表便认定官方订阅');
        await databaseEdit((database) => database.prepare('UPDATE providers SET category = ? WHERE id = ? AND app_type = ?')
          .run('official', 'official-codex', 'codex'));
        fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), officialMirror.replace('requires_openai_auth = true', 'requires_openai_auth = false'));
        result = await resolveRoutes();
        check(result.codex.billingType === 'unknown' && result.codex.diagnostics.includes('codex-chatgpt-backend-unverified'),
          '缺少官方后端证据时未报告具体诊断');
      }],
      [85, 'AGENT_ROUTE_DEPTH：执行方环境带该变量，递归派发被拦截', () => {
        const depthEnv = { ...env, AGENT_ROUTE_DEPTH: '1' };
        const before = invocations();
        const rows = history().length;
        const cooldownPath = path.join(home, 'state', 'cooldown.json');
        const cooldownBefore = fs.existsSync(cooldownPath) ? fs.readFileSync(cooldownPath, 'utf8') : null;
        for (const args of [['tier1', '--cwd', repo], ['tier2', '--cwd', repo, '--monitor'],
          ['tier1', '--cwd', repo, '--resume', '00000000-0000-0000-0000-000000000000']]) {
          const blocked = spawnSync(process.execPath, [SCRIPT_PATH, ...args],
            { env: depthEnv, input: 'AGENT_ROUTE_SELFTEST:complete\n', encoding: 'utf8', timeout: 5000 });
          exitIs(blocked, 12);
          check(blocked.stdout.startsWith('ERROR\n') && blocked.stdout.includes('执行方内部不能再调用 agent-route'), `未输出拦截 ERROR: ${blocked.stdout}`);
        }
        check(invocations() === before, '被拦截的派发调用了 codex-stub');
        check(history().length === rows, '被拦截的派发写了 history');
        check((fs.existsSync(cooldownPath) ? fs.readFileSync(cooldownPath, 'utf8') : null) === cooldownBefore, '被拦截的派发改动了冷却');
        for (const command of ['status', 'stats']) {
          const result = spawnSync(process.execPath, [SCRIPT_PATH, command], { env: depthEnv, cwd: repo, encoding: 'utf8', timeout: 5000 });
          exitIs(result, 0);
          check(!result.stdout.includes('执行方内部'), `${command} 被误拦`);
        }
        for (const claude of [false, true]) {
          const normal = run('complete', claude ? ['--claude'] : [], true);
          exitIs(normal, 0);
          const call = (claude ? claudeCalls() : invocationRows()).at(-1);
          if (claude) {
            const args = invocationRows().filter((row) => row.command === '-p').at(-1).args;
            const at = args.indexOf('--settings');
            check(at >= 0 && args[at + 1] === JSON.stringify({ permissions: { deny: ['Skill(agent-route)'] } }), 'Claude 参数缺少 --settings deny Skill(agent-route)');
          }
          check(claude ? call.envKeys.includes('AGENT_ROUTE_DEPTH') && call.agentRouteDepth === '1'
            : call.agentRouteDepth === '1', `${claude ? 'Claude' : 'Codex'} 执行方环境缺少 AGENT_ROUTE_DEPTH=1`);
        }
      }],
    );
    for (const [id, name, test] of scenarios) {
      try {
        await test();
        console.log(`PASS ${id} ${name}`);
      } catch (e) {
        failed = true;
        console.log(`FAIL ${id} ${name}`);
        console.log(`  原因: ${String(e.message).replace(/\s+/g, ' ').trim()}`);
      }
    }
  } catch (e) {
    failed = true;
    console.log('FAIL selftest 初始化');
    console.log(`  原因: ${String(e.message).replace(/\s+/g, ' ').trim()}`);
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
      catch (e) {
        failed = true;
        console.log('FAIL selftest 清理');
        console.log(`  原因: ${String(e.message).replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
  return failed ? 1 : 0;
}
