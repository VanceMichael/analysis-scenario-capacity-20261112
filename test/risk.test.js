import test from 'node:test';
import assert from 'node:assert/strict';
import { cvar, prepareWeights, tailAnalysis } from '../src/risk.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} 与 ${expected} 不接近`);
};

const lossesOf = (analysis, scenarioIds) => {
  assert.deepEqual(analysis.members.map(member => member.id).sort(), scenarioIds.sort());
  const total = analysis.members.reduce((sum, member) => sum + member.weightInTail * member.loss, 0);
  close(total / analysis.tailMass, analysis.cvar);
};

test('加权平均与尾部 CVaR 与手算一致', () => {
  const losses = [0, 10, 20, 30];
  const weights = [0.25, 0.25, 0.25, 0.25];
  const analysis = tailAnalysis(losses, weights, 0.5, { ids: ['s0', 's1', 's2', 's3'] });
  close(analysis.expected, 15);
  close(analysis.cvar, 25);
  assert.equal(analysis.boundary, null);
  assert.equal(analysis.actualTailMass, 0.5);
  lossesOf(analysis, ['s2', 's3']);
});

test('离散情景跨过分位边界时只计入部分权重', () => {
  // 尾部权重 0.25 落在 30 这一情景内部：30 * (0.25/0.4) / 0.25 = 30
  const analysis = tailAnalysis([0, 10, 20, 30], [0.1, 0.2, 0.3, 0.4], 0.75,
    { ids: ['a', 'b', 'c', 'd'] });
  close(analysis.cvar, 30);
  assert.equal(analysis.members.length, 1);
  close(analysis.members[0].inclusionFraction, 0.625);
  close(analysis.members[0].weightInTail, 0.25);
  assert.deepEqual(analysis.boundary.memberIds, ['d']);

  // 边界落在第二档：尾部 0.45 = 0.4 的 30 全部 + 0.3 的 20 中 0.05
  const mixed = tailAnalysis([0, 10, 20, 30], [0.1, 0.2, 0.3, 0.4], 0.55,
    { ids: ['a', 'b', 'c', 'd'] });
  close(mixed.cvar, (30 * 0.4 + 20 * 0.05) / 0.45);
  close(mixed.boundary.includedFraction, 0.05 / 0.3);
  assert.equal(mixed.boundary.loss, 20);
});

test('同值尾部按权重比例分摊边界份额', () => {
  const analysis = tailAnalysis([10, 10, 10, 0], [0.25, 0.25, 0.25, 0.25], 0.5);
  close(analysis.cvar, 10);
  close(analysis.expected, 7.5);
  assert.equal(analysis.members.length, 3);
  for (const member of analysis.members) {
    close(member.inclusionFraction, 0.5 / 0.75);
    close(member.weightInTail, 0.25 * (0.5 / 0.75));
  }
  close(analysis.members.reduce((sum, member) => sum + member.weightInTail, 0), 0.5);
});

test('零权重情景不进入尾部也不影响 CVaR', () => {
  const withZeros = tailAnalysis([10, 10, 0, 0], [0, 0.5, 0, 0.5], 0.5,
    { ids: ['s0', 's1', 's2', 's3'] });
  const withoutZeros = tailAnalysis([10, 0], [0.5, 0.5], 0.5, { ids: ['s1', 's2'] });
  close(withZeros.cvar, withoutZeros.cvar);
  assert.ok(withZeros.members.every(member => member.id !== 's0'));
  assert.ok(withZeros.members.every(member => member.normalizedWeight > 0));

  const allZeroWeight = prepareWeights([0, 1], 'weights', {});
  close(allZeroWeight.normalized[0], 0);
});

test('权重未声明为概率时拒绝概率化风险解释', () => {
  const weights = [0.5, 0.5];
  const losses = [0, 10];
  const analysis = tailAnalysis(losses, weights, 0.5, { semantics: 'weights' });
  assert.equal(analysis.probabilityInterpretation, false);
  assert.throws(() => tailAnalysis(losses, weights, 0.5, {
    semantics: 'weights',
    requireProbability: true
  }), /不是预测概率/);
  const asProbabilities = tailAnalysis(losses, weights, 0.5, { semantics: 'probabilities' });
  assert.equal(asProbabilities.probabilityInterpretation, true);
  assert.throws(() => tailAnalysis([0, 10], [0.5, 0.6], 0.5, { semantics: 'probabilities' }),
    /总和不为 1/);
});

test('权重全为零、负权重与非法 alpha 被拒绝', () => {
  assert.throws(() => tailAnalysis([1, 2], [0, 0], 0.5), /总和必须大于零/);
  assert.throws(() => tailAnalysis([1, 2], [1, -1], 0.5), /不能为负/);
  assert.throws(() => tailAnalysis([1, 2], [0.5, 0.5], 1), /alpha/);
  assert.throws(() => tailAnalysis([1, 2, 3], [1, 2], 0.5), /长度不一致/);
});

test('alpha 为 0 时尾部覆盖全部情景，CVaR 等于加权平均', () => {
  const losses = [3, 1, 4, 1, 5];
  const weights = [0.1, 0.2, 0.3, 0.2, 0.2];
  close(cvar(losses, weights, 0.8), tailAnalysis(losses, weights, 0.8).cvar);
  const whole = tailAnalysis(losses, weights, 0);
  close(whole.cvar, whole.expected);
  close(whole.cvar, 2.9);
  assert.equal(whole.members.length, 5);
});
