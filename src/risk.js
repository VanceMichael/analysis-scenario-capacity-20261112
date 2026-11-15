// 离散情景下的加权平均与 CVaR。
//
// 情景权重只有在调用方明确声明为预测概率时，才能作概率化解释；
// 否则权重只作为归一化后的规划权重使用。CVaR 的尾部会按离散情景
// 实际跨过 (1 - alpha) 分位边界的比例计入部分权重；同值尾部在组内
// 按权重比例分摊边界份额。

const EPS = 1e-12;

export const WEIGHT_SEMANTICS = Object.freeze({
  WEIGHTS: 'weights',
  PROBABILITIES: 'probabilities'
});

const PROBABILITY_ALIASES = new Set(['probabilities', 'probability', 'probabilistic']);
const WEIGHT_ALIASES = new Set(['weights', 'weight', 'scenario-weights']);

function finiteArray(values, name) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name}必须是非空数组`);
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name}第 ${index + 1} 项必须是有限数值`);
    }
  }
}

export function canonicalSemantics(value = WEIGHT_SEMANTICS.WEIGHTS) {
  if (typeof value !== 'string') throw new Error('weightSemantics 应为 weights 或 probabilities');
  if (WEIGHT_ALIASES.has(value)) return WEIGHT_SEMANTICS.WEIGHTS;
  if (PROBABILITY_ALIASES.has(value)) return WEIGHT_SEMANTICS.PROBABILITIES;
  throw new Error('weightSemantics 应为 weights 或 probabilities');
}

export function prepareWeights(weights, semantics = WEIGHT_SEMANTICS.WEIGHTS, options = {}) {
  finiteArray(weights, '情景权重');
  const normalizedSemantics = canonicalSemantics(semantics);
  for (const [index, weight] of weights.entries()) {
    if (weight < 0) throw new Error(`情景权重第 ${index + 1} 项不能为负`);
  }
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (!(sum > 0)) throw new Error('情景权重总和必须大于零');
  if (options.requireProbability && normalizedSemantics !== WEIGHT_SEMANTICS.PROBABILITIES) {
    throw new Error('场景权重不是预测概率，拒绝概率化风险解释；如确为概率，请将 weightSemantics 设为 probabilities');
  }
  const probabilityInterpretation = normalizedSemantics === WEIGHT_SEMANTICS.PROBABILITIES;
  if (probabilityInterpretation && Math.abs(sum - 1) > 1e-9 * Math.max(1, Math.abs(sum))) {
    throw new Error('权重声明为预测概率，但总和不为 1');
  }
  return {
    semantics: normalizedSemantics,
    probabilityInterpretation,
    sum,
    normalized: weights.map(weight => weight / sum)
  };
}

function validateAlpha(alpha) {
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha >= 1) {
    throw new Error('alpha 必须是大于等于 0 且小于 1 的有限数值');
  }
}

/**
 * 返回 CVaR 数值；参数与 tailAnalysis 相同。
 */
export function cvar(losses, weights, alpha, options = {}) {
  return tailAnalysis(losses, weights, alpha, options).cvar;
}

/**
 * 计算加权平均缺口、CVaR 及尾部成员。
 *
 * 离散尾部的处理：
 *   - 按损失从大到小排列；同值损失归为一组，组内按情景 id 稳定排序；
 *   - 从尾部累计到 1 - alpha；
 *   - 若边界落在一个同值组内部，组内每个情景按剩余尾部权重比例
 *     计入部分权重，组内分摊是确定的；
 *   - 零权重情景不进入尾部，也不影响 CVaR。
 */
export function tailAnalysis(losses, weights, alpha, options = {}) {
  finiteArray(losses, '情景损失');
  if (losses.length !== weights.length) throw new Error('情景损失与权重长度不一致');
  validateAlpha(alpha);
  const prepared = prepareWeights(weights, options.semantics, options);
  const ids = options.ids ?? losses.map((_, index) => `s${index}`);
  if (!Array.isArray(ids) || ids.length !== losses.length) throw new Error('情景 id 数量与损失不一致');

  const records = losses.map((loss, index) => ({
    index,
    id: String(ids[index]),
    loss,
    weight: weights[index],
    normalizedWeight: prepared.normalized[index]
  }));
  records.sort((left, right) => {
    if (right.loss !== left.loss) return right.loss - left.loss;
    return left.id.localeCompare(right.id, 'en') || left.index - right.index;
  });

  const target = 1 - alpha;
  let remaining = target;
  let contribution = 0;
  let actualTailMass = 0;
  const members = [];
  let boundary = null;
  let groupIndex = 0;

  for (let start = 0; start < records.length;) {
    let end = start;
    while (end < records.length && records[end].loss === records[start].loss) end += 1;
    const group = records.slice(start, end).filter(record => record.normalizedWeight > 0);
    start = end;
    if (group.length === 0) continue;
    if (!(remaining > 1e-15)) break;
    const groupWeight = group.reduce((total, record) => total + record.normalizedWeight, 0);
    const fullGroup = groupWeight <= remaining + EPS;
    const fraction = fullGroup ? 1 : remaining / groupWeight;
    const weightTaken = fullGroup ? groupWeight : remaining;
    group.forEach((record, positionInGroup) => {
      const weightInTail = record.normalizedWeight * fraction;
      members.push({
        index: record.index,
        id: record.id,
        loss: record.loss,
        weight: record.weight,
        normalizedWeight: record.normalizedWeight,
        weightInTail,
        inclusionFraction: fraction,
        shareOfTail: target > 0 ? weightInTail / target : 0,
        contribution: weightInTail * record.loss,
        tailOrder: members.length,
        groupIndex,
        positionInGroup
      });
    });
    contribution += weightTaken * records[start - 1].loss;
    actualTailMass += weightTaken;
    remaining -= weightTaken;
    if (!fullGroup) {
      boundary = {
        loss: records[start - 1].loss,
        includedFraction: fraction,
        groupWeight,
        weightTaken,
        memberIds: group.map(record => record.id)
      };
    }
    groupIndex += 1;
  }

  const expected = records.reduce(
    (total, record) => total + record.normalizedWeight * record.loss, 0);
  const cvarValue = target > EPS ? contribution / target : expected;

  return {
    expected,
    cvar: cvarValue,
    alpha,
    tailMass: target,
    actualTailMass,
    members,
    boundary,
    semantics: prepared.semantics,
    probabilityInterpretation: prepared.probabilityInterpretation,
    weightSum: prepared.sum,
    normalizedWeights: prepared.normalized,
    method: 'weighted-discrete-tail-with-boundary-fraction'
  };
}

