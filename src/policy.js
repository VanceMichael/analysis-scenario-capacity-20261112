import { readFile } from 'node:fs/promises';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function requireFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数值`);
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
  return value;
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} 必须是非空字符串数组`);
  const seen = new Set();
  for (const entry of value) {
    requireString(entry, `${name} 的条目`);
    if (seen.has(entry)) throw new Error(`${name} 含重复项 ${entry}`);
    seen.add(entry);
  }
  return [...value];
}

/**
 * 校验本地业务配置。只接受已知字段的合法值；未知字段被忽略。
 *
 * workers[].available 是本地给定的班次可用性（布尔）；
 * workers[].home 是人员所属服务点，跨点调动成本按目的服务点计。
 */
export function validatePolicy(input) {
  if (!isPlainObject(input)) throw new Error('业务配置必须是 JSON 对象');
  const policy = {};

  policy.budget = requireNonNegativeInteger(input.budget, 'budget');

  policy.minutesPerWorker = requireFinite(input.minutesPerWorker, 'minutesPerWorker');
  if (policy.minutesPerWorker <= 0) throw new Error('minutesPerWorker 必须大于零');

  policy.alpha = requireFinite(input.alpha, 'alpha');
  if (policy.alpha < 0 || policy.alpha >= 1) throw new Error('alpha 必须大于等于 0 且小于 1');

  policy.riskWeight = requireFinite(input.riskWeight, 'riskWeight');
  if (policy.riskWeight < 0) throw new Error('riskWeight 不能为负');

  policy.weightSemantics = input.weightSemantics ?? 'weights';
  if (!['weights', 'probabilities'].includes(policy.weightSemantics)) {
    throw new Error('weightSemantics 应为 weights 或 probabilities');
  }

  if (!isPlainObject(input.minimum)) throw new Error('minimum 必须是服务点到非负整数的对象');
  policy.minimum = {};
  for (const [point, count] of Object.entries(input.minimum)) {
    requireString(point, 'minimum 的服务点键');
    policy.minimum[point] = requireNonNegativeInteger(count, `minimum.${point}`);
  }

  policy.transferCost = {};
  if (input.transferCost !== undefined) {
    if (!isPlainObject(input.transferCost)) throw new Error('transferCost 必须是服务点到数值的对象');
    for (const [point, cost] of Object.entries(input.transferCost)) {
      requireString(point, 'transferCost 的服务点键');
      policy.transferCost[point] = requireFinite(cost, `transferCost.${point}`);
      if (policy.transferCost[point] < 0) throw new Error(`transferCost.${point} 不能为负`);
    }
  }

  if (!Array.isArray(input.workers) || input.workers.length === 0) {
    throw new Error('workers 必须是非空人员数组');
  }
  const workerIds = new Set();
  policy.workers = input.workers.map((worker, index) => {
    if (!isPlainObject(worker)) throw new Error(`workers[${index}] 必须是对象`);
    const id = requireString(worker.id, `workers[${index}].id`);
    if (workerIds.has(id)) throw new Error(`人员 id 重复：${id}`);
    workerIds.add(id);
    const home = worker.home === undefined || worker.home === null ? null
      : requireString(worker.home, `workers[${index}].home`);
    const available = worker.available === undefined ? true : worker.available;
    if (typeof available !== 'boolean') throw new Error(`workers[${index}].available 必须是布尔值`);
    return {
      id,
      languages: stringList(worker.languages, `workers[${index}].languages`),
      points: stringList(worker.points, `workers[${index}].points`),
      home,
      available
    };
  });

  return policy;
}

export async function loadPolicy(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  return validatePolicy(document);
}
