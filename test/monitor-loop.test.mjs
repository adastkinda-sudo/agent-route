// monitor-loop 离线测试：命令、模型和桌面通知均使用临时 stub。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const monitor = fileURLToPath(new URL('../bin/monitor-loop', import.meta.url));

function run(t, { direct = false, output = 'ok\n', stderr = '', rc = 0,
  modelOutput = 'STATUS: OK\n运行正常\n', modelRc = 0, iterations = 1, timeout = 1, hang = false } = {}) {
  const fixtureDir = fileURLToPath(new URL('../state/', import.meta.url));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const home = fs.mkdtempSync(path.join(fixtureDir, 'monitor-loop-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.claude', 'agent-route', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fixture = { output, stderr, rc, modelOutput, modelRc, hang };
  fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify(fixture));
  const stub = (name, source) => fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\n` +
    `const home = process.env.HOME;\nconst fixture = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json')));\n${source}\n`,
    { mode: 0o755 });
  stub('agent-route', `fs.appendFileSync(path.join(home, 'model-calls'), 'called\\n');
fs.appendFileSync(path.join(home, 'model-args.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fixture.modelOutput);
process.exitCode = fixture.modelRc;`);
  stub('osascript', `fs.appendFileSync(path.join(home, 'notifications.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');`);
  stub('command', `process.stdout.write(fixture.output);
process.stderr.write(fixture.stderr);
if (fixture.hang) setInterval(() => {}, 1000);
else process.exitCode = fixture.rc;`);
  const log = path.join(home, 'monitor.log');
  fs.mkdirSync(path.join(home, 'tmp'));
  const result = spawnSync('/bin/bash', [monitor, '--name', 'stub', '--interval', '0',
    '--cwd', home, '--log', log, '--max-iterations', String(iterations), '--cmd-timeout', String(timeout),
    ...(direct ? ['--direct'] : []), '--', path.join(bin, 'command')],
  { env: { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), TMPDIR: path.join(home, 'tmp'), PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-route', 'state', 'monitor-stub.pid')), false);
  const read = (name) => fs.existsSync(path.join(home, name)) ? fs.readFileSync(path.join(home, name), 'utf8') : '';
  return { ...result, log: read('monitor.log'), modelCalls: read('model-calls'),
    modelArgs: read('model-args.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse),
    notifications: read('notifications.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('direct: ok 和异常关键词仅写日志，不调用模型或通知', (t) => {
  const output = 'ok\nError Exception FAILED nan banana finance\n普通行中的 ALERT 不转发\n';
  const result = run(t, { direct: true, output });
  assert.equal(result.stdout, '');
  assert.equal(result.modelCalls, '');
  assert.deepEqual(result.notifications, []);
  assert.ok(result.log.includes(output));
  assert.match(result.log, /direct/);
});

test('direct: 完整输出中的 ALERT 行原样转发，包含 stderr 和无末尾换行的行', (t) => {
  const first = 'ALERT 首条 "引号" \\路径  ';
  const last = 'ALERT stderr 末条';
  const output = `${first}\n${'ok\n'.repeat(250)}  ALERT 不在行首\n`;
  const result = run(t, { direct: true, output, stderr: last });
  assert.equal(result.stdout, `${first}\n${last}\n`);
  assert.equal(result.modelCalls, '');
  assert.equal(result.notifications.length, 2);
  assert.ok(result.log.includes(output + last));
  assert.ok(result.notifications[0][1].includes('ALERT 首条'));
  assert.ok(result.notifications[1][1].includes(last));
});

test('direct: 命令非零退出单独告警并通知', (t) => {
  const result = run(t, { direct: true, rc: 7 });
  assert.match(result.stdout, /^ALERT \[stub\] 命令退出码 7/);
  assert.doesNotMatch(result.stdout, /MONITOR_ERROR/);
  assert.equal(result.modelCalls, '');
  assert.equal(result.notifications.length, 1);
  assert.match(result.log, /cmd exit 7/);
});

test('direct: 原始告警与非零退出都保留', (t) => {
  const result = run(t, { direct: true, output: 'ALERT 原始告警\n', rc: 9 });
  assert.match(result.stdout, /^ALERT 原始告警\nALERT \[stub\] 命令退出码 9/);
  assert.equal(result.notifications.length, 2);
  assert.equal(result.modelCalls, '');
});

test('direct: 空输出正常退出不告警', (t) => {
  const result = run(t, { direct: true, output: '' });
  assert.equal(result.stdout, '');
  assert.deepEqual(result.notifications, []);
  assert.equal(result.modelCalls, '');
});

test('direct: 多轮不沿用上轮告警', (t) => {
  const result = run(t, { direct: true, output: 'ALERT 每轮一次\n', iterations: 2 });
  assert.equal(result.stdout, 'ALERT 每轮一次\nALERT 每轮一次\n');
  assert.equal(result.notifications.length, 2);
  assert.equal(result.modelCalls, '');
  assert.match(result.log, /iter 2/);
});

test('direct: 命令超时视为非零退出告警', (t) => {
  const result = run(t, { direct: true, hang: true, timeout: 0 });
  assert.match(result.stdout, /^ALERT \[stub\] 命令退出码 124/);
  assert.match(result.log, /命令超时/);
  assert.equal(result.notifications.length, 1);
  assert.equal(result.modelCalls, '');
});

test('默认模式: STATUS OK 保持正常', (t) => {
  const result = run(t);
  assert.equal(result.stdout, '');
  assert.equal(result.modelCalls, 'called\n');
  assert.deepEqual(result.modelArgs[0].slice(0, 4), ['tier2', '--no-claude', '--monitor', '--cwd']);
  assert.equal(result.modelArgs[0][5], '--prompt-file');
  assert.equal(result.notifications.length, 1);
  assert.match(result.log, /STATUS: OK/);
});

test('默认模式: STATUS ALERT 保持运行告警', (t) => {
  const result = run(t, { modelOutput: 'STATUS: ALERT\n运行停滞\n' });
  assert.match(result.stdout, /^ALERT \[stub\] 运行停滞/);
  assert.doesNotMatch(result.stdout, /MONITOR_ERROR/);
  assert.equal(result.notifications.length, 1);
});

test('默认模式: 无法解析的模型输出只报 MONITOR_ERROR', (t) => {
  const result = run(t, { modelOutput: 'ok\n' });
  assert.match(result.stdout, /^MONITOR_ERROR \[stub\] 无法解析模型输出/);
  assert.doesNotMatch(result.stdout, /^ALERT/m);
  assert.match(result.log, /MONITOR_ERROR/);
  assert.equal(result.notifications.length, 1);
});

test('默认模式: 模型解析故障与命令失败分开报告', (t) => {
  const result = run(t, { modelOutput: '', rc: 3 });
  assert.match(result.stdout, /^MONITOR_ERROR \[stub\] 无法解析模型输出/m);
  assert.match(result.stdout, /^ALERT \[stub\] 命令退出码 3/m);
  assert.doesNotMatch(result.stdout, /^ALERT.*无法解析/m);
  assert.equal(result.notifications.length, 2);
});

test('默认模式: agent-route 异常退出为监控故障', (t) => {
  const result = run(t, { modelRc: 12 });
  assert.match(result.stdout, /^MONITOR_ERROR \[stub\] agent-route 异常退出（退出码 12）/);
  assert.doesNotMatch(result.stdout, /^ALERT/m);
  assert.equal(result.notifications.length, 1);
});

test('默认模式: 模型不可用时保留关键词回退', (t) => {
  const normal = run(t, { modelRc: 10, output: 'ok banana finance\n' });
  assert.equal(normal.stdout, '');
  const failure = run(t, { modelRc: 10, output: 'Error: failed\n' });
  assert.match(failure.stdout, /^ALERT .*关键词命中异常/m);
});

test('默认模式: 模型 OK 时命令非零退出仍告警', (t) => {
  const result = run(t, { rc: 4 });
  assert.match(result.stdout, /^ALERT \[stub\] 命令退出码 4；运行正常/);
  assert.equal(result.notifications.length, 1);
});
