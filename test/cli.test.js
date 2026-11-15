import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseArguments } from '../src/cli.js';
import { buildModel } from '../src/capacity.js';

const tinyRecords = [
  { id: 'a0', scenario: 'low', point: 'gate', demand: 30, weight: 0.5, language: 'en' },
  { id: 'a1', scenario: 'low', point: 'hall', demand: 40, weight: 0.5, language: 'fr' },
  { id: 'b0', scenario: 'mid', point: 'gate', demand: 70, weight: 0.5, language: 'en' },
  { id: 'b1', scenario: 'mid', point: 'hall', demand: 80, weight: 0.5, language: 'fr' }
];
const tinyPolicy = {
  budget: 2,
  minutesPerWorker: 60,
  alpha: 0.5,
  riskWeight: 1,
  minimum: { gate: 1, hall: 1 },
  transferCost: {},
  workers: [
    { id: 'en-1', languages: ['en'], points: ['gate'] },
    { id: 'fr-1', languages: ['fr'], points: ['hall'] }
  ]
};

async function withFiles(files, run) {
  const folder = await mkdtemp(join(tmpdir(), 'capacity-cli-'));
  try {
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(folder, name);
      await writeFile(paths[name], JSON.stringify(content));
    }
    return await run(paths, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('capacity 命令从本地情景与配置读入并落盘', async () => {
  await withFiles({
    'records.json': { version: 1, records: tinyRecords },
    'policy.json': tinyPolicy
  }, async (paths, folder) => {
    const output = join(folder, 'var', 'capacity.json');
    const document = await main(['capacity', '--input', paths['records.json'],
      '--policy', paths['policy.json'], '--out', output]);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(written, JSON.parse(JSON.stringify(document)));
    assert.equal(document.feasible, true);
    assert.equal(document.search.risk.optimality, 'global-optimum');
    assert.equal(document.settings.weightSemantics, 'weights');
    assert.ok(Number.isSafeInteger(document.riskAverse.totalAssigned));
    assert.equal(document.model.scenarios, 2);
  });
});

test('--budget 覆盖配置预算，--require-probability 拒绝概率化解释', async () => {
  await withFiles({
    'records.json': { version: 1, records: tinyRecords },
    'policy.json': tinyPolicy
  }, async paths => {
    const infeasible = await main(['capacity', '--input', paths['records.json'],
      '--policy', paths['policy.json'], '--budget', '1']);
    assert.equal(infeasible.feasible, false);
    assert.equal(infeasible.settings.budget, 1);
    assert.ok(infeasible.conflicts.length > 0);

    await assert.rejects(main(['capacity', '--input', paths['records.json'],
      '--policy', paths['policy.json'], '--require-probability']), /不是预测概率/);

    const asProbabilities = { ...tinyPolicy, weightSemantics: 'probabilities' };
    await writeFile(paths['policy.json'], JSON.stringify(asProbabilities));
    const probabilistic = await main(['capacity', '--input', paths['records.json'],
      '--policy', paths['policy.json'], '--require-probability']);
    assert.equal(probabilistic.weightsAreProbabilities, true);
    assert.equal(probabilistic.riskAverse.tail.probabilityInterpretation, true);
  });
});

test('命令参数拒绝未知命令、悬空值和重复项', () => {
  assert.equal(parseArguments([]).command, 'summary');
  assert.equal(parseArguments(['capacity']).command, 'capacity');
  assert.throws(() => parseArguments(['unknown']), /命令/);
  assert.throws(() => parseArguments(['summary', '--out']), /命令/);
  assert.throws(() => parseArguments(['capacity', '--budget', '-1']), /非负整数/);
  assert.throws(() => parseArguments(['capacity', '--budget', '2', '--budget', '3']), /重复/);
  assert.throws(() => parseArguments(['summary', '--policy', 'x.json']), /capacity/);
});

test('命令行在错误输入时返回非零退出码', async () => {
  await withFiles({
    'records.json': { version: 1, records: tinyRecords },
    'policy.json': tinyPolicy
  }, async paths => {
    const run = spawnSync(process.execPath,
      ['src/cli.js', 'capacity', '--input', paths['records.json'], '--policy', paths['policy.json'],
        '--budget', '0'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).feasible, false);

    const broken = spawnSync(process.execPath,
      ['src/cli.js', 'capacity', '--input', paths['records.json'], '--policy', paths['records.json']],
      { encoding: 'utf8' });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /处理失败/);
  });
});

test('容量演示在数十秒内完成且只读本地文件', async () => {
  const started = performance.now();
  const run = spawnSync(process.execPath, ['scripts/demo.js'], { encoding: 'utf8' });
  const elapsed = performance.now() - started;
  assert.equal(run.status, 0, run.stderr);
  assert.ok(elapsed < 30000, `演示耗时 ${elapsed} 毫秒`);
  assert.match(run.stdout, /容量建议/);
  assert.match(run.stdout, /不是预测概率/);
});
