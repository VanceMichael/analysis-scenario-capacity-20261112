import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  analyze,
  buildModel,
  infeasibilityConflicts,
  scenarioWide,
  solve
} from '../src/capacity.js';
import { validatePolicy } from '../src/policy.js';
import { cvar } from '../src/risk.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} 与 ${expected} 不接近`);
};

// 小实例：两个服务点、三个情景，需求为联合向量。
const tinyRecords = [
  { id: 'a0', scenario: 'low', point: 'gate', demand: 30, weight: 0.5, language: 'en' },
  { id: 'a1', scenario: 'low', point: 'hall', demand: 40, weight: 0.5, language: 'fr' },
  { id: 'b0', scenario: 'mid', point: 'gate', demand: 70, weight: 0.3, language: 'en' },
  { id: 'b1', scenario: 'mid', point: 'hall', demand: 80, weight: 0.3, language: 'fr' },
  { id: 'c0', scenario: 'peak', point: 'gate', demand: 110, weight: 0.2, language: 'en' },
  { id: 'c1', scenario: 'peak', point: 'hall', demand: 100, weight: 0.2, language: 'fr' }
];

const tinyPolicy = {
  budget: 3,
  minutesPerWorker: 60,
  alpha: 0.6,
  riskWeight: 1,
  minimum: { gate: 1, hall: 1 },
  transferCost: { gate: 5, hall: 5 },
  workers: [
    { id: 'en-1', languages: ['en'], points: ['gate'] },
    { id: 'en-2', languages: ['en'], points: ['gate'] },
    { id: 'fr-1', languages: ['fr'], points: ['hall'] },
    { id: 'fr-2', languages: ['fr'], points: ['hall'] },
    { id: 'bi-1', languages: ['en', 'fr'], points: ['gate', 'hall'] }
  ]
};

// 独立于求解器的穷举：枚举每名人员的去向，按定义重算缺口与 CVaR。
// CVaR 用对偶公式 min_t [ t + 1/(1-alpha) * E[(L-t)+] ] 重算，
// 不调用 src/risk.js 的尾部累计实现。
function independentCvar(losses, weights, alpha) {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const target = 1 - alpha;
  let best = Infinity;
  for (const threshold of new Set(losses)) {
    const excess = losses.reduce((total, loss, index) =>
      total + (weights[index] / sum) * Math.max(0, loss - threshold), 0);
    best = Math.min(best, threshold + excess / target);
  }
  return best;
}

function bruteForce(records, policy, riskWeight) {
  const policyChecked = validatePolicy(policy);
  const scenarios = scenarioWide(records);
  const workerOptions = policyChecked.workers
    .filter(worker => worker.available)
    .map(worker => {
      const eligible = scenarios.points.filter(point =>
        worker.points.includes(point) && worker.languages.includes(scenarios.languages[point]));
      return [-1, ...eligible];
    });
  const effectiveMinutes = (worker, point) => policyChecked.minutesPerWorker
    - (worker.home !== null && worker.home !== point ? (policyChecked.transferCost[point] ?? 0) : 0);
  let best = null;
  let feasiblePlans = 0;
  const total = workerOptions.reduce((product, list) => product * list.length, 1);
  for (let combination = 0; combination < total; combination += 1) {
    let remainder = combination;
    const picks = workerOptions.map(list => {
      const pick = list[remainder % list.length];
      remainder = Math.floor(remainder / list.length);
      return pick;
    });
    const assigned = picks.filter(pick => pick !== -1).length;
    if (assigned > policyChecked.budget) continue;
    const headcount = Object.fromEntries(scenarios.points.map(point => [point, 0]));
    const capacity = Object.fromEntries(scenarios.points.map(point => [point, 0]));
    picks.forEach((pick, workerIndex) => {
      if (pick === -1) return;
      headcount[pick] += 1;
      capacity[pick] += effectiveMinutes(policyChecked.workers[workerIndex], pick);
    });
    if (scenarios.points.some(point => headcount[point] < (policyChecked.minimum[point] ?? 0))) continue;
    feasiblePlans += 1;
    const losses = scenarios.ids.map((id, index) => scenarios.points
      .map(point => Math.max(0, scenarios.demands[index][point] - capacity[point]))
      .reduce((sumGap, gap) => sumGap + gap, 0));
    const sum = scenarios.weights.reduce((totalWeight, weight) => totalWeight + weight, 0);
    const expected = losses.reduce((sumLosses, loss, index) =>
      sumLosses + loss * (scenarios.weights[index] / sum), 0);
    const tail = independentCvar(losses, scenarios.weights, policyChecked.alpha);
    const objective = expected + riskWeight * tail;
    if (best === null || objective < best.objective) {
      best = { objective, expected, tail, losses, headcount, picks, totalAssigned: assigned };
    }
  }
  return { best, feasiblePlans, total };
}

test('联合情景读取不拼分位数，缺行或权重不一致直接拒绝', () => {
  const scenarios = scenarioWide(tinyRecords);
  assert.deepEqual(scenarios.ids, ['low', 'mid', 'peak']);
  assert.deepEqual(scenarios.points, ['gate', 'hall']);
  // peak 情景的 gate 与 hall 来自同一行世界
  assert.equal(scenarios.demands[2].gate, 110);
  assert.equal(scenarios.demands[2].hall, 100);

  const missing = tinyRecords.filter(row => row.id !== 'c1');
  assert.throws(() => scenarioWide(missing), /缺少服务点 hall/);
  const mismatched = tinyRecords.map(row =>
    row.id === 'c1' ? { ...row, weight: 0.25 } : row);
  assert.throws(() => scenarioWide(mismatched), /权重不一致/);
});

test('整数小实例的整数最优解与独立穷举一致', () => {
  const model = buildModel(tinyRecords, tinyPolicy);
  const expected = bruteForce(tinyRecords, tinyPolicy, 1);
  const risk = solve(model, { riskWeight: 1 });
  assert.equal(risk.search.method, 'exhaustive-enumeration');
  assert.equal(risk.search.status, 'complete');
  assert.equal(risk.search.optimality, 'global-optimum');
  close(risk.plan.objective, expected.best.objective);
  assert.equal(risk.plan.totalAssigned, expected.best.totalAssigned);
  close(risk.plan.cvar, expected.best.tail);
  for (const point of model.points) {
    assert.equal(risk.plan.headcount[point], expected.best.headcount[point]);
  }
  assert.ok(risk.plan.headcount.gate >= tinyPolicy.minimum.gate);
  assert.ok(risk.plan.headcount.hall >= tinyPolicy.minimum.hall);

  const average = solve(model, { riskWeight: 0 });
  close(average.plan.objective, average.plan.expectedShortfall);
  close(average.plan.expectedShortfall, bruteForce(tinyRecords, tinyPolicy, 0).best.expected);

  // 每个情景的缺口都从需求与容量逐点重算
  for (const scenario of risk.plan.scenarios) {
    for (const point of model.points) {
      const cell = scenario.perPoint[point];
      close(cell.shortfall, Math.max(0, cell.demand - cell.capacity));
      assert.ok(cell.capacity >= 0);
    }
  }
});

test('目标显式包含期望缺口和 CVaR，尾部成员可复核', () => {
  const model = buildModel(tinyRecords, tinyPolicy);
  const result = solve(model, { riskWeight: 1 });
  const plan = result.plan;
  const manualExpected = plan.scenarios.reduce((sum, scenario) =>
    sum + scenario.shortfall * (scenario.weight / model.weightSum), 0);
  close(plan.expectedShortfall, manualExpected);
  close(plan.cvar, cvar(plan.scenarios.map(scenario => scenario.shortfall),
    model.weights, tinyPolicy.alpha));
  close(plan.objective, plan.expectedShortfall + plan.riskWeight * plan.cvar);
  assert.equal(plan.tail.members.length > 0, true);
  const tailScenario = plan.scenarios.find(scenario => scenario.tailMember);
  assert.ok(tailScenario);
  close(tailScenario.weightInTail,
    plan.tail.members.find(member => member.id === tailScenario.id).weightInTail);
  assert.equal(plan.tail.probabilityInterpretation, false);
});

test('同值尾部在部分权重边界上按比例分摊', () => {
  // 4 情景等权，尾部 0.4 落在同值组中间
  const records = [
    { id: 'x0', scenario: 's0', point: 'p', demand: 20, weight: 0.25, language: 'en' },
    { id: 'x1', scenario: 's1', point: 'p', demand: 20, weight: 0.25, language: 'en' },
    { id: 'x2', scenario: 's2', point: 'p', demand: 20, weight: 0.25, language: 'en' },
    { id: 'x3', scenario: 's3', point: 'p', demand: 0, weight: 0.25, language: 'en' }
  ];
  const policy = {
    budget: 0, minutesPerWorker: 60, alpha: 0.6, riskWeight: 1,
    minimum: { p: 0 }, transferCost: {}, workers: [
      { id: 'w', languages: ['en'], points: ['p'], available: false }
    ]
  };
  const model = buildModel(records, policy);
  const result = solve(model, { riskWeight: 1 });
  assert.equal(result.plan.totalAssigned, 0);
  close(result.plan.cvar, 20);
  close(result.plan.tail.actualTailMass, 0.4);
  assert.equal(result.plan.tail.members.length, 3);
  for (const member of result.plan.tail.members) close(member.inclusionFraction, 0.4 / 0.75);
});

test('零权重情景不计入尾部也不改变最优解', () => {
  const records = tinyRecords.map(row => row.scenario === 'mid' ? { ...row, weight: 0 } : row);
  const model = buildModel(records, tinyPolicy);
  const result = solve(model, { riskWeight: 1 });
  assert.ok(result.plan.tail.members.every(member => member.id !== 'mid'));
  close(result.plan.tail.actualTailMass, 0.4);
  close(result.plan.cvar, cvar(result.plan.scenarios.map(scenario => scenario.shortfall),
    model.weights, tinyPolicy.alpha));
});

test('home、跨点调动成本与班次不可用都计入穷举核对', () => {
  const policy = {
    budget: 3,
    minutesPerWorker: 50,
    alpha: 0.5,
    riskWeight: 2,
    minimum: { gate: 1, hall: 1 },
    transferCost: { gate: 10, hall: 20 },
    workers: [
      { id: 'en-home', languages: ['en'], points: ['gate', 'hall'], home: 'gate' },
      { id: 'en-flex', languages: ['en'], points: ['gate'] },
      { id: 'fr-home', languages: ['fr'], points: ['hall'], home: 'hall' },
      { id: 'fr-off', languages: ['fr'], points: ['hall'], home: 'hall', available: false },
      { id: 'bi', languages: ['en', 'fr'], points: ['gate', 'hall'], home: 'hall' }
    ]
  };
  const model = buildModel(tinyRecords, policy);
  const expected = bruteForce(tinyRecords, policy, 2);
  const result = solve(model, { riskWeight: 2 });
  close(result.plan.objective, expected.best.objective);
  close(result.plan.cvar, expected.best.tail);
  for (const point of model.points) {
    assert.equal(result.plan.headcount[point], expected.best.headcount[point]);
  }
  // 调动成本计入有效分钟：home 与目的点不同才扣
  for (const worker of result.plan.assignedWorkers) {
    const home = model.workers.find(entry => entry.id === worker.worker).home;
    const expectedTransfer = home !== null && home !== worker.point
      ? policy.transferCost[worker.point] : 0;
    assert.equal(worker.transferCost, expectedTransfer);
    assert.equal(worker.effectiveMinutes, policy.minutesPerWorker - expectedTransfer);
  }
  assert.ok(result.plan.assignedWorkers.every(worker => worker.worker !== 'fr-off'));

  // 把 off 人员改回当班后，同一预算的缺口不应变差
  const restored = { ...policy, workers: policy.workers.map(worker =>
    worker.id === 'fr-off' ? { ...worker, available: true } : worker) };
  const withExtra = solve(buildModel(tinyRecords, restored), { riskWeight: 2 });
  assert.ok(withExtra.plan.expectedShortfall <= result.plan.expectedShortfall + 1e-9);
});

test('预算不足与某语种完全无人可用时报告约束冲突', async () => {
  const tightBudget = analyze(buildModel(tinyRecords, { ...tinyPolicy, budget: 1 }));
  assert.equal(tightBudget.feasible, false);
  assert.equal(tightBudget.feasibility, 'infeasible');
  const conflict = tightBudget.conflicts.find(entry => entry.type === 'budget-vs-minimum');
  assert.ok(conflict);
  assert.equal(conflict.required, 2);
  assert.equal(conflict.budget, 1);
  assert.deepEqual(conflict.constraints, ['budget', 'minimum']);
  assert.equal(tightBudget.search.optimality, 'infeasible');
  assert.equal(tightBudget.search.proven, true);

  // 没有任何人员会 fr，hall 的最低保障无法满足
  const noFrench = { ...tinyPolicy, workers: tinyPolicy.workers.filter(worker => !worker.languages.includes('fr')) };
  const result = analyze(buildModel(tinyRecords, noFrench));
  assert.equal(result.feasible, false);
  const languageConflict = result.conflicts.find(entry =>
    entry.type === 'minimum-vs-eligibility' && entry.points.includes('hall'));
  assert.ok(languageConflict, JSON.stringify(result.conflicts));
  assert.equal(languageConflict.language, 'fr');
  assert.deepEqual(languageConflict.eligibleWorkers, []);
  assert.ok(result.managerBrief.headline.includes('不可行'));
  assert.equal(result.managerBrief.conflicts.length, result.conflicts.length);

  // 无人会 fr 但最低保障为 0：可行，缺口全额计入，不伪装成不可行
  const zeroMinimum = { ...noFrench, minimum: { gate: 1, hall: 0 } };
  const feasible = analyze(buildModel(tinyRecords, zeroMinimum));
  assert.equal(feasible.feasible, true);
  assert.equal(feasible.riskAverse.headcount.hall, 0);
  assert.deepEqual(feasible.model.uncoveredPoints, ['hall']);
  assert.ok(feasible.riskAverse.scenarios.every(scenario => scenario.perPoint.hall.shortfall > 0));
});

test('不可行组只报告最小组，不做超集重复', () => {
  const records = tinyRecords;
  const policy = {
    ...tinyPolicy,
    budget: 1,
    minimum: { gate: 1, hall: 1 }
  };
  const model = buildModel(records, policy);
  const conflicts = infeasibilityConflicts(model, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'budget-vs-minimum');
  assert.deepEqual(conflicts[0].points, ['gate', 'hall']);
});

test('搜索截断时只报告界限，不标全局最优', () => {
  const unavailablePolicy = { ...tinyPolicy, workers: tinyPolicy.workers.map(worker => ({ ...worker })) };
  const model = buildModel(tinyRecords, unavailablePolicy);
  const truncated = solve(model, { riskWeight: 1, search: { maxNodes: 3, exhaustiveLimit: 1 } });
  assert.equal(truncated.search.method, 'branch-and-bound');
  assert.equal(truncated.search.status, 'truncated');
  assert.equal(truncated.search.optimality, 'bounded-search');
  assert.equal(truncated.search.proven, false);
  assert.equal(truncated.search.optimalityGuaranteed, false);
  assert.equal(truncated.search.reason, 'node-limit');
  if (truncated.plan) {
    assert.ok(truncated.search.lowerBound <= truncated.search.upperBound);
    assert.ok(truncated.search.gap >= 0);
  }

  const complete = solve(model, { riskWeight: 1, search: { exhaustiveLimit: 1, maxNodes: 100000 } });
  assert.equal(complete.search.status, 'complete');
  assert.equal(complete.search.optimality, 'global-optimum');
  assert.equal(complete.search.gap, 0);
  close(complete.plan.objective, solve(model, { riskWeight: 1 }).plan.objective);
});

test('分支定界的完整搜索与完整枚举结果一致', () => {
  const model = buildModel(tinyRecords, tinyPolicy);
  for (const riskWeight of [0, 1, 3]) {
    const enumerated = solve(model, { riskWeight, search: { exhaustiveLimit: 100000 } });
    const bounded = solve(model, { riskWeight, search: { exhaustiveLimit: 1, maxNodes: 100000 } });
    close(bounded.plan.objective, enumerated.plan.objective);
    close(bounded.plan.cvar, enumerated.plan.cvar);
    assert.equal(bounded.search.status, 'complete');
    assert.equal(bounded.search.optimality, 'global-optimum');
  }
});

test('演练配置的容量建议可复核且数十秒内完成', async () => {
  const records = JSON.parse(await readFile('data/records.json', 'utf8')).records;
  const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));
  const started = performance.now();
  const result = analyze(await buildModel(records, policy));
  assert.ok(performance.now() - started < 20000);
  assert.equal(result.feasible, true);
  assert.equal(result.search.risk.optimality, 'global-optimum');
  for (const role of ['averageOptimal', 'riskAverse']) {
    const plan = result[role];
    close(plan.objective, plan.expectedShortfall + plan.riskWeight * plan.cvar);
    assert.equal(plan.totalAssigned <= policy.budget, true);
    assert.equal(plan.scenarios.length, 24);
  }
  assert.ok(result.riskInterpretation.includes('不是预测概率'));
  assert.equal(result.weightsAreProbabilities, false);
  // 把平均最优方案代入同一风险目标，风险厌恶方案不应更差
  const averageUnderRisk = result.averageOptimal.expectedShortfall
    + result.settings.riskWeight * result.averageOptimal.cvar;
  assert.ok(result.riskAverse.objective <= averageUnderRisk + 1e-9);
  assert.ok(result.marginalWorker.available);
  assert.equal(result.marginalWorker.search.optimality, 'global-optimum');
});
