import { validatePolicy } from './policy.js';
import { canonicalSemantics, prepareWeights, tailAnalysis } from './risk.js';

// 容量建议模块。
//
// 数据口径
//   - 情景按 scenario 整行读取：同一 scenario 下各服务点的需求是同一个世界；
//     不会把各服务点的分位数分别拼成“从未发生的世界”。缺少任一服务点、
//     或同一 scenario 权重不一致的行会被拒绝，不做边际拼接。
//   - 人员为整数，每名人员最多派到一个服务点，或不派出；不能拆出半个人。
//   - 服务点 p 在情景 s 的可用分钟 = 派往该点且在班人员的有效分钟之和。
//     有效分钟 = minutesPerWorker；派往非 home 服务点还要扣除本地配置的
//     调动成本（按目的服务点计，单位与需求一致，即服务分钟）。
//   - 情景缺口 = 各服务点 max(0, 需求分钟 - 可用分钟) 之和。
//   - 目标 = 期望缺口 + riskWeight × CVaR(alpha)，两项单位均为服务分钟。
//     权重未声明为预测概率时，“期望缺口”只是给定情景上的加权平均，
//     不作概率或预测解释。
//
// 最优性
//   - exhaustive-enumeration：完整枚举全部整数分配，可断言全局最优；
//   - branch-and-bound：搜索完整结束且未被截断时才可断言全局最优；
//   - 节点数或时限截断时只报告已知最好解与上下界（bounded-search），
//     不称全局最优。

export const DEFAULT_SEARCH = Object.freeze({
  exhaustiveLimit: 100000,
  maxNodes: 300000,
  timeLimitMs: 15000
});

const EPS = 1e-9;
const SORT_LOCALE = 'en';
const compareText = (left, right) => left.localeCompare(right, SORT_LOCALE);

function weightTolerance(value) {
  return 1e-9 * Math.max(1, Math.abs(value));
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 把记录折叠成联合情景，并检查每个情景都有完整的服务点需求行。
 * 返回的情景按 id 排序，需求向量按服务点排序。
 */
export function scenarioWide(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('情景数据为空');
  const points = [...new Set(records.map(record => String(record.point)))].sort(compareText);
  const byScenario = new Map();
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`第 ${index + 1} 行不是对象`);
    }
    const scenario = String(record.scenario);
    const point = String(record.point);
    if (!byScenario.has(scenario)) {
      byScenario.set(scenario, { id: scenario, weight: record.weight, cells: new Map() });
    }
    const entry = byScenario.get(scenario);
    if (typeof record.weight !== 'number' || !Number.isFinite(record.weight) || record.weight < 0) {
      throw new Error(`情景 ${scenario} 的权重必须是非负有限数值`);
    }
    if (Math.abs(entry.weight - record.weight) > weightTolerance(entry.weight)) {
      throw new Error(`情景 ${scenario} 的权重不一致，不能按服务点重复归一`);
    }
    if (entry.cells.has(point)) throw new Error(`情景 ${scenario} 的服务点 ${point} 重复`);
    if (typeof record.demand !== 'number' || !Number.isFinite(record.demand) || record.demand < 0) {
      throw new Error(`情景 ${scenario} 服务点 ${point} 的需求必须是非负有限数值`);
    }
    if (typeof record.language !== 'string' || record.language.length === 0) {
      throw new Error(`情景 ${scenario} 服务点 ${point} 缺少语言`);
    }
    entry.cells.set(point, { demand: record.demand, language: record.language });
  }
  const ids = [...byScenario.keys()].sort(compareText);
  const languages = {};
  for (const point of points) {
    const seen = new Set();
    for (const id of ids) {
      const entry = byScenario.get(id);
      if (!entry.cells.has(point)) throw new Error(`情景 ${id} 缺少服务点 ${point} 的联合需求`);
      seen.add(entry.cells.get(point).language);
    }
    if (seen.size !== 1) throw new Error(`服务点 ${point} 在各情景中的语言不一致`);
    languages[point] = [...seen][0];
  }
  return {
    ids,
    points,
    languages,
    weights: ids.map(id => byScenario.get(id).weight),
    demands: ids.map(id => Object.fromEntries(points.map(point =>
      [point, byScenario.get(id).cells.get(point).demand])))
  };
}

function validateModelInputs(policy, scenarios) {
  const points = new Set(scenarios.points);
  for (const point of Object.keys(policy.minimum)) {
    if (!points.has(point)) throw new Error(`最低保障引用了未知服务点 ${point}`);
  }
  for (const point of Object.keys(policy.transferCost)) {
    if (!points.has(point)) throw new Error(`调动成本引用了未知服务点 ${point}`);
    if (policy.transferCost[point] >= policy.minutesPerWorker) {
      throw new Error(`服务点 ${point} 的调动成本不得大于等于单人服务分钟`);
    }
  }
  const workerIds = new Set();
  for (const worker of policy.workers) {
    if (workerIds.has(worker.id)) throw new Error(`人员 id 重复：${worker.id}`);
    workerIds.add(worker.id);
    for (const point of worker.points) {
      if (!points.has(point)) throw new Error(`人员 ${worker.id} 引用了未知服务点 ${point}`);
    }
    if (worker.home !== null && !points.has(worker.home)) {
      throw new Error(`人员 ${worker.id} 的 home 引用了未知服务点 ${worker.home}`);
    }
    if (worker.home !== null && !worker.points.includes(worker.home)) {
      throw new Error(`人员 ${worker.id} 的 home 不在其可服务点内`);
    }
  }
}

/**
 * 构建容量模型。记录和配置都是显式输入，不读取隐藏状态。
 * options.requireProbability 要求权重已声明为预测概率。
 */
export function buildModel(records, policyInput, options = {}) {
  const policy = validatePolicy(policyInput);
  const scenarios = scenarioWide(records);
  validateModelInputs(policy, scenarios);
  const semantics = canonicalSemantics(policy.weightSemantics);
  const weightInfo = prepareWeights(scenarios.weights, semantics, {
    requireProbability: options.requireProbability === true
  });

  const workers = policy.workers.map(worker => {
    const eligiblePoints = worker.available
      ? scenarios.points.filter(point =>
        worker.points.includes(point) && worker.languages.includes(scenarios.languages[point]))
      : [];
    const minutesByPoint = {};
    for (const point of eligiblePoints) {
      const transferCost = worker.home !== null && point !== worker.home
        ? policy.transferCost[point] : 0;
      minutesByPoint[point] = {
        transferCost,
        effectiveMinutes: policy.minutesPerWorker - transferCost
      };
    }
    return {
      id: worker.id,
      languages: [...worker.languages],
      points: [...worker.points],
      home: worker.home,
      available: worker.available,
      eligiblePoints,
      minutesByPoint
    };
  });

  return {
    scenarioIds: scenarios.ids,
    points: scenarios.points,
    languages: scenarios.languages,
    demands: scenarios.demands,
    weights: scenarios.weights,
    normalizedWeights: weightInfo.normalized,
    weightSum: weightInfo.sum,
    weightSemantics: weightInfo.semantics,
    probabilityInterpretation: weightInfo.probabilityInterpretation,
    minutesPerWorker: policy.minutesPerWorker,
    budget: policy.budget,
    alpha: policy.alpha,
    riskWeight: policy.riskWeight,
    minimum: Object.fromEntries(scenarios.points.map(point => [point, policy.minimum[point] ?? 0])),
    transferCost: Object.fromEntries(scenarios.points.map(point => [point, policy.transferCost[point] ?? 0])),
    workers,
    uncoveredPoints: scenarios.points.filter(point =>
      !workers.some(worker => worker.eligiblePoints.includes(point)))
  };
}

function evaluate(model, assignment, alpha) {
  const { scenarioIds, points, demands } = model;
  const capacity = scenarioIds.map(() => points.map(() => 0));
  const headcount = Object.fromEntries(points.map(point => [point, 0]));
  const assignedWorkers = [];
  let totalAssigned = 0;
  let totalTransferMinutes = 0;
  for (const [workerIndex, pointIndex] of assignment.entries()) {
    if (pointIndex === -1) continue;
    const worker = model.workers[workerIndex];
    const point = points[pointIndex];
    totalAssigned += 1;
    headcount[point] += 1;
    const minutes = worker.minutesByPoint[point];
    totalTransferMinutes += minutes.transferCost;
    for (let scenarioIndex = 0; scenarioIndex < scenarioIds.length; scenarioIndex += 1) {
      capacity[scenarioIndex][pointIndex] += minutes.effectiveMinutes;
    }
    assignedWorkers.push({
      worker: worker.id,
      point,
      home: worker.home,
      transferCost: minutes.transferCost,
      effectiveMinutes: minutes.effectiveMinutes
    });
  }

  const scenarios = scenarioIds.map((id, scenarioIndex) => {
    const perPoint = {};
    let shortfall = 0;
    for (const [pointIndex, point] of points.entries()) {
      const demand = demands[scenarioIndex][point];
      const available = capacity[scenarioIndex][pointIndex];
      const gap = Math.max(0, demand - available);
      shortfall += gap;
      perPoint[point] = { demand, capacity: available, shortfall: gap };
    }
    return {
      id,
      weight: model.weights[scenarioIndex],
      normalizedWeight: model.normalizedWeights[scenarioIndex],
      shortfall,
      perPoint,
      tailMember: false,
      tailInclusion: 0,
      weightInTail: 0
    };
  });

  const tail = tailAnalysis(scenarios.map(scenario => scenario.shortfall), model.weights, alpha, {
    semantics: model.weightSemantics,
    ids: scenarioIds
  });
  const tailByScenario = new Map(tail.members.map(member => [member.id, member]));
  for (const scenario of scenarios) {
    const member = tailByScenario.get(scenario.id);
    scenario.tailMember = Boolean(member);
    scenario.tailInclusion = member ? member.inclusionFraction : 0;
    scenario.weightInTail = member ? member.weightInTail : 0;
  }

  return {
    assignment: [...assignment],
    totalAssigned,
    headcount,
    transferMinutes: totalTransferMinutes,
    assignedWorkers,
    scenarios,
    expectedShortfall: tail.expected,
    cvar: tail.cvar,
    objective: tail.expected + model.riskWeight * tail.cvar,
    riskWeight: model.riskWeight,
    alpha,
    tail: {
      alpha: tail.alpha,
      tailMass: tail.tailMass,
      actualTailMass: tail.actualTailMass,
      method: tail.method,
      semantics: tail.semantics,
      probabilityInterpretation: tail.probabilityInterpretation,
      boundary: tail.boundary,
      members: tail.members
    }
  };
}

function feasible(model, assignment, budget) {
  let assigned = 0;
  const headcount = Object.fromEntries(model.points.map(point => [point, 0]));
  for (const [workerIndex, pointIndex] of assignment.entries()) {
    if (pointIndex === -1) continue;
    assigned += 1;
    headcount[model.points[pointIndex]] += 1;
  }
  if (assigned > budget) return false;
  return model.points.every(point => headcount[point] >= model.minimum[point]);
}

function comparePlans(candidate, incumbent) {
  if (incumbent === null) return -1;
  if (candidate.objective !== incumbent.objective) return candidate.objective - incumbent.objective;
  if (candidate.expectedShortfall !== incumbent.expectedShortfall) {
    return candidate.expectedShortfall - incumbent.expectedShortfall;
  }
  if (candidate.cvar !== incumbent.cvar) return candidate.cvar - incumbent.cvar;
  for (let index = 0; index < candidate.assignment.length; index += 1) {
    if (candidate.assignment[index] !== incumbent.assignment[index]) {
      return candidate.assignment[index] - incumbent.assignment[index];
    }
  }
  return 0;
}

function optionsFor(model) {
  return model.workers.map(worker => [
    -1,
    ...worker.eligiblePoints
      .map(point => model.points.indexOf(point))
      .sort((left, right) => left - right)
  ]);
}

function combinationCount(options) {
  return options.reduce((product, list) => product * list.length, 1);
}

/**
 * 对未分配人员作乐观松弛：每名未分配人员可同时补齐所有符合资格的服务点；
 * 已分配人员只按实际服务点计入。得到的逐情景缺口不高于任何完成方案，
 * 因此目标值可作为分支定界下界。
 */
function lowerBoundLosses(model, assignment) {
  return model.scenarioIds.map((id, scenarioIndex) => {
    let total = 0;
    for (const point of model.points) {
      let capacity = 0;
      for (const [workerIndex, worker] of model.workers.entries()) {
        if (!worker.eligiblePoints.includes(point)) continue;
        const minutes = worker.minutesByPoint[point].effectiveMinutes;
        if (assignment[workerIndex] === -1 || model.points[assignment[workerIndex]] === point) {
          capacity += minutes;
        }
      }
      const remaining = model.demands[scenarioIndex][point] - capacity;
      if (remaining > 0) total += remaining;
    }
    return total;
  });
}

function lowerBound(model, assignment, alpha) {
  const tail = tailAnalysis(lowerBoundLosses(model, assignment), model.weights, alpha, {
    semantics: model.weightSemantics,
    ids: model.scenarioIds
  });
  return tail.expected + model.riskWeight * tail.cvar;
}

function searchDetails(overrides) {
  return {
    method: null,
    status: 'complete',
    optimality: 'infeasible',
    proven: true,
    nodesEvaluated: 0,
    feasiblePlans: 0,
    lowerBound: null,
    upperBound: null,
    gap: null,
    reason: null,
    ...overrides
  };
}

function exhaustiveSearch(model, budget, alpha, options) {
  const combinations = combinationCount(options);
  const assignment = model.workers.map(() => -1);
  let incumbent = null;
  let feasiblePlans = 0;
  let evaluated = 0;

  const recurse = depth => {
    if (depth === model.workers.length) {
      evaluated += 1;
      if (!feasible(model, assignment, budget)) return;
      feasiblePlans += 1;
      const plan = evaluate(model, assignment, alpha);
      if (comparePlans(plan, incumbent) < 0) incumbent = plan;
      return;
    }
    for (const pointIndex of options[depth]) {
      assignment[depth] = pointIndex;
      recurse(depth + 1);
    }
    assignment[depth] = -1;
  };
  recurse(0);

  return {
    plan: incumbent,
    search: searchDetails({
      method: 'exhaustive-enumeration',
      status: 'complete',
      optimality: incumbent ? 'global-optimum' : 'infeasible',
      proven: true,
      combinations,
      nodesEvaluated: evaluated,
      feasiblePlans,
      lowerBound: incumbent ? incumbent.objective : null,
      upperBound: incumbent ? incumbent.objective : null,
      gap: incumbent ? 0 : null
    })
  };
}

function boundedSearch(model, budget, alpha, limits) {
  const options = optionsFor(model);
  const combinations = combinationCount(options);
  const root = model.workers.map(() => -1);
  const stack = [{ assignment: root, depth: 0, bound: lowerBound(model, root, alpha) }];
  let incumbent = null;
  let feasiblePlans = 0;
  let nodesEvaluated = 0;
  let prunedNodes = 0;
  let truncated = false;
  let reason = null;
  const started = performance.now();

  while (stack.length > 0) {
    if (nodesEvaluated >= limits.maxNodes) {
      truncated = true;
      reason = 'node-limit';
      break;
    }
    if (performance.now() - started > limits.timeLimitMs) {
      truncated = true;
      reason = 'time-limit';
      break;
    }
    const node = stack.pop();
    if (incumbent !== null && node.bound >= incumbent.objective - EPS) {
      prunedNodes += 1;
      continue;
    }
    nodesEvaluated += 1;
    if (node.depth === model.workers.length) {
      if (!feasible(model, node.assignment, budget)) continue;
      feasiblePlans += 1;
      const plan = evaluate(model, node.assignment, alpha);
      if (comparePlans(plan, incumbent) < 0) incumbent = plan;
      continue;
    }
    const children = options[node.depth].map(pointIndex => {
      const assignment = [...node.assignment];
      assignment[node.depth] = pointIndex;
      return { assignment, depth: node.depth + 1 };
    }).map(child => ({ ...child, bound: lowerBound(model, child.assignment, alpha) }));
    // 先压入下界较大的子节点，使其后压入并先被弹出，优先探索更有希望的分支
    children.sort((left, right) => left.bound - right.bound);
    for (const child of children) {
      if (incumbent !== null && child.bound >= incumbent.objective - EPS) {
        prunedNodes += 1;
      } else {
        stack.push(child);
      }
    }
  }

  const complete = !truncated && stack.length === 0;
  const frontierMinimum = stack.length === 0 ? null
    : Math.min(...stack.map(node => node.bound));
  const incumbentBound = incumbent === null ? null : incumbent.objective;
  const lower = frontierMinimum === null ? incumbentBound
    : incumbentBound === null ? frontierMinimum
      : Math.min(frontierMinimum, incumbentBound);
  return {
    plan: incumbent,
    search: searchDetails({
      method: 'branch-and-bound',
      status: complete ? 'complete' : 'truncated',
      optimality: complete
        ? (incumbent ? 'global-optimum' : 'infeasible')
        : 'bounded-search',
      proven: complete,
      combinations,
      nodesEvaluated,
      feasiblePlans,
      prunedNodes,
      frontierNodes: stack.length,
      lowerBound: lower,
      upperBound: incumbentBound,
      gap: incumbentBound !== null && lower !== null
        ? Math.max(0, incumbentBound - lower) : null,
      reason: complete ? null : reason
    })
  };
}

/**
 * 固定预算下求解。riskWeight 为 0 时即加权平均缺口最优。
 *
 * search 参数只控制搜索，不改变目标函数；截断时返回 bounded-search，
 * optimalityGuaranteed 为 false。
 */
export function solve(model, settings = {}) {
  const budget = settings.budget ?? model.budget;
  if (!isNonNegativeInteger(budget)) throw new Error('预算必须是非负整数');
  const alpha = settings.alpha ?? model.alpha;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha >= 1) {
    throw new Error('alpha 必须大于等于 0 且小于 1');
  }
  const riskWeight = settings.riskWeight ?? model.riskWeight;
  if (typeof riskWeight !== 'number' || !Number.isFinite(riskWeight) || riskWeight < 0) {
    throw new Error('riskWeight 必须是非负有限数值');
  }
  const limits = { ...DEFAULT_SEARCH, ...(settings.search ?? {}) };
  if (!isNonNegativeInteger(limits.exhaustiveLimit)) throw new Error('exhaustiveLimit 必须是非负整数');
  if (!isNonNegativeInteger(limits.maxNodes)) throw new Error('maxNodes 必须是非负整数');
  if (!Number.isFinite(limits.timeLimitMs) || limits.timeLimitMs <= 0) {
    throw new Error('timeLimitMs 必须是正的有限数值');
  }
  const effectiveModel = { ...model, riskWeight };
  const options = optionsFor(model);
  const combinations = combinationCount(options);
  const result = combinations <= limits.exhaustiveLimit
    ? exhaustiveSearch(effectiveModel, budget, alpha, options)
    : boundedSearch(effectiveModel, budget, alpha, limits);
  return {
    ...result,
    search: {
      ...result.search,
      budget,
      alpha,
      riskWeight,
      combinations,
      searchMode: result.search.method,
      limits,
      optimalityGuaranteed: result.search.optimality === 'global-optimum'
    }
  };
}

function describePlan(plan) {
  return {
    objective: plan.objective,
    expectedShortfall: plan.expectedShortfall,
    cvar: plan.cvar,
    alpha: plan.alpha,
    riskWeight: plan.riskWeight,
    totalAssigned: plan.totalAssigned,
    headcount: plan.headcount,
    transferMinutes: plan.transferMinutes,
    assignment: plan.assignedWorkers,
    scenarios: plan.scenarios,
    tail: plan.tail
  };
}

function compareForManager(average, riskAverse, model, riskWeight) {
  const headcountChange = Object.fromEntries(model.points.map(point =>
    [point, riskAverse.headcount[point] - average.headcount[point]]));
  const averageUnderRisk = average.expectedShortfall + riskWeight * average.cvar;
  const scenarios = average.scenarios.map((scenario, index) => {
    const other = riskAverse.scenarios[index];
    return {
      id: scenario.id,
      weight: scenario.weight,
      averageShortfall: scenario.shortfall,
      riskAverseShortfall: other.shortfall,
      change: other.shortfall - scenario.shortfall,
      tailMember: other.tailMember
    };
  });
  return {
    description: 'averageOptimal 只最小化加权平均缺口（同值时取较小 CVaR）；'
      + 'riskAverse 最小化期望缺口 + riskWeight × CVaR。',
    samePlan: average.totalAssigned === riskAverse.totalAssigned
      && model.points.every(point => headcountChange[point] === 0),
    averageUnderRisk: {
      expectedShortfall: average.expectedShortfall,
      cvar: average.cvar,
      objective: averageUnderRisk
    },
    difference: {
      expectedShortfall: riskAverse.expectedShortfall - average.expectedShortfall,
      cvar: riskAverse.cvar - average.cvar,
      objective: riskAverse.objective - averageUnderRisk
    },
    headcountChange,
    scenariosImproved: scenarios.filter(scenario => scenario.change < 0),
    scenariosWorsened: scenarios.filter(scenario => scenario.change > 0),
    scenarios
  };
}

function assignableWorkers(model) {
  return model.workers.filter(worker => worker.eligiblePoints.length > 0);
}

function marginalWorker(model, plan, budget, alpha, riskWeight, limits) {
  if (budget >= assignableWorkers(model).length) {
    return {
      available: false,
      saturated: true,
      addedBudget: budget + 1,
      reason: '没有更多可派人员；增加预算不会增加可用人员'
    };
  }
  const next = solve(model, { budget: budget + 1, alpha, riskWeight, search: limits });
  if (!next.plan) {
    return {
      available: true,
      feasible: next.search.proven ? false : null,
      addedBudget: budget + 1,
      search: next.search,
      reason: next.search.proven
        ? '增加一名人员后仍无可行分配'
        : '增加一名人员后的搜索被截断，既未找到方案也未证明不可行；请放宽搜索界限'
    };
  }
  const nextPlan = next.plan;
  const headcountChange = Object.fromEntries(model.points.map(point =>
    [point, nextPlan.headcount[point] - plan.headcount[point]]));
  const perPoint = {};
  for (const point of model.points) {
    const before = model.normalizedWeights.reduce((sum, weight, index) =>
      sum + weight * plan.scenarios[index].perPoint[point].shortfall, 0);
    const after = model.normalizedWeights.reduce((sum, weight, index) =>
      sum + weight * nextPlan.scenarios[index].perPoint[point].shortfall, 0);
    perPoint[point] = {
      expectedShortfallBefore: before,
      expectedShortfallAfter: after,
      expectedShortfallChange: after - before,
      headcountChange: headcountChange[point]
    };
  }
  const scenarios = plan.scenarios.map((scenario, index) => ({
    id: scenario.id,
    weight: scenario.weight,
    before: scenario.shortfall,
    after: nextPlan.scenarios[index].shortfall,
    reduction: scenario.shortfall - nextPlan.scenarios[index].shortfall
  }));
  return {
    available: true,
    feasible: true,
    addedBudget: budget + 1,
    totalAssigned: nextPlan.totalAssigned,
    expectedShortfallChange: nextPlan.expectedShortfall - plan.expectedShortfall,
    cvarChange: nextPlan.cvar - plan.cvar,
    objectiveChange: nextPlan.objective - plan.objective,
    headcountChange,
    perPoint,
    scenarios,
    improvedScenarios: scenarios.filter(scenario => scenario.reduction > 0)
      .sort((left, right) => right.reduction - left.reduction),
    unchangedScenarios: scenarios.filter(scenario => scenario.reduction === 0),
    plan: describePlan(nextPlan),
    search: next.search
  };
}

function pruneSupersets(conflicts) {
  return conflicts.filter((conflict, index, all) => {
    const points = conflict.points;
    return !all.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (other.points.length >= points.length) return false;
      return other.points.every(point => points.includes(point));
    });
  });
}

/**
 * 诊断不可行约束组。只报告最小组：
 *   budget-vs-minimum       最低保障人数合计超过预算；
 *   minimum-vs-eligibility  单点最低保障超过当班且语言符合的可派人员；
 *   minimum-vs-eligibility  多服务点合计要求超过能覆盖这些点的不同人员数。
 * 冲突只说明哪组约束互相矛盾，不伪装成最优性结论。
 */
export function infeasibilityConflicts(model, budget) {
  const conflicts = [];
  const points = model.points;
  const minimumTotal = points.reduce((sum, point) => sum + model.minimum[point], 0);
  if (minimumTotal > budget) {
    conflicts.push({
      type: 'budget-vs-minimum',
      constraints: ['budget', 'minimum'],
      points: points.filter(point => model.minimum[point] > 0),
      required: minimumTotal,
      budget,
      detail: `最低保障合计需要 ${minimumTotal} 人，超过预算 ${budget} 人`
    });
  }
  for (const point of points) {
    if (model.minimum[point] === 0) continue;
    const eligibleWorkers = model.workers
      .filter(worker => worker.eligiblePoints.includes(point))
      .map(worker => worker.id);
    if (eligibleWorkers.length < model.minimum[point]) {
      const unavailableWorkers = model.workers
        .filter(worker => !worker.available && worker.points.includes(point)
          && worker.languages.includes(model.languages[point]))
        .map(worker => worker.id);
      conflicts.push({
        type: 'minimum-vs-eligibility',
        constraints: ['minimum', 'eligibility', 'shift-availability'],
        points: [point],
        language: model.languages[point],
        required: model.minimum[point],
        eligibleWorkers,
        unavailableWorkers,
        detail: `服务点 ${point}（语言 ${model.languages[point]}）最低需要 ${model.minimum[point]} 人，`
          + `当班且语言符合的可派人员只有 ${eligibleWorkers.length} 人`
          + (unavailableWorkers.length > 0
            ? `；另有 ${unavailableWorkers.join('、')} 会该语言但不在班` : '')
      });
    }
  }
  const required = points.filter(point => model.minimum[point] > 0);
  if (required.length > 1 && required.length <= 16) {
    for (let mask = 1; mask < (1 << required.length); mask += 1) {
      const subset = required.filter((point, index) => (mask & (1 << index)) !== 0);
      if (subset.length < 2) continue;
      const requiredCount = subset.reduce((sum, point) => sum + model.minimum[point], 0);
      const eligibleWorkers = model.workers
        .filter(worker => subset.some(point => worker.eligiblePoints.includes(point)))
        .map(worker => worker.id);
      if (eligibleWorkers.length < requiredCount) {
        conflicts.push({
          type: 'minimum-vs-eligibility',
          constraints: ['minimum', 'eligibility', 'shift-availability'],
          points: subset,
          required: requiredCount,
          eligibleWorkers,
          detail: `服务点 ${subset.join(', ')} 最低合计需要 ${requiredCount} 人，`
            + `能覆盖这些点的不同人员只有 ${eligibleWorkers.length} 人`
        });
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const conflict of conflicts) {
    const identifier = `${conflict.type}|${conflict.points.join(',')}`;
    if (!seen.has(identifier)) {
      seen.add(identifier);
      unique.push(conflict);
    }
  }
  const pruned = pruneSupersets(unique);
  if (pruned.length === 0) {
    // 枚举已证明不可行，但最小冲突组未在以上规则中显式出现：
    // 至少要把挨着的约束和当前计数暴露出来，而不是给一张空表。
    pruned.push({
      type: 'combined-constraints',
      constraints: ['budget', 'minimum', 'eligibility', 'shift-availability'],
      points: points.filter(point => model.minimum[point] > 0),
      required: minimumTotal,
      budget,
      eligibleWorkers: model.workers
        .filter(worker => worker.eligiblePoints.length > 0)
        .map(worker => worker.id),
      detail: `在预算 ${budget} 人、最低保障合计 ${minimumTotal} 人及班次可用性下，`
        + '不存在满足全部约束的整数分配；请核对预算、最低保障或可派人员'
    });
  }
  return pruned;
}

function managerBrief(result) {
  if (result.feasible === false || result.feasible === null) {
    const headline = result.feasible === null
      ? '搜索未找到可行分配且未完成证明，不能断定不可行。'
      : '当前预算与最低保障组合不可行，没有可执行分配。';
    return {
      headline,
      conflicts: result.conflicts.map(conflict => conflict.detail)
    };
  }
  const lines = [];
  if (result.comparison === null) {
    lines.push(result.comparisonNote);
  } else if (result.comparison.samePlan) {
    lines.push('平均损失最优与风险厌恶方案在本实例中相同。');
  } else {
    const moved = Object.entries(result.comparison.headcountChange)
      .filter(([, change]) => change !== 0)
      .map(([point, change]) => `${point}${change > 0 ? '+' : ''}${change}`);
    lines.push(`风险厌恶方案相对平均最优调整人员：${moved.join('，')}；`
      + `CVaR 变化 ${result.comparison.difference.cvar.toFixed(2)} 分钟，`
      + `平均缺口变化 ${result.comparison.difference.expectedShortfall.toFixed(2)} 分钟。`);
  }
  const marginal = result.marginalWorker;
  if (!marginal.available) {
    lines.push(marginal.reason);
  } else if (!marginal.feasible) {
    lines.push(marginal.reason);
  } else {
    const pointChanges = Object.entries(marginal.perPoint)
      .filter(([, entry]) => entry.expectedShortfallChange < -EPS)
      .map(([point, entry]) => `${point} 平均缺口 ${entry.expectedShortfallChange.toFixed(2)} 分钟`);
    lines.push(`多花一名人员（预算 ${marginal.addedBudget}）`
      + `${marginal.improvedScenarios.length > 0
        ? `改善 ${marginal.improvedScenarios.length} 个情景` : '未改善任何情景'}`
      + `${pointChanges.length > 0 ? `，主要来自 ${pointChanges.join('，')}` : ''}；`
      + `平均缺口变化 ${marginal.expectedShortfallChange.toFixed(2)} 分钟，`
      + `CVaR 变化 ${marginal.cvarChange.toFixed(2)} 分钟。`);
  }
  return { headline: lines.join(' '), conflicts: [] };
}

/**
 * 主分析入口。
 * options: { budget, alpha, riskWeight, search, requireProbability }
 */
export function analyze(model, options = {}) {
  if (options.requireProbability === true && !model.probabilityInterpretation) {
    throw new Error('场景权重不是预测概率，拒绝概率化风险解释；'
      + '如确为概率，请将 weightSemantics 设为 probabilities');
  }
  const budget = options.budget ?? model.budget;
  const alpha = options.alpha ?? model.alpha;
  const riskWeight = options.riskWeight ?? model.riskWeight;
  const search = options.search ?? {};
  const risk = solve(model, { budget, alpha, riskWeight, search });
  const context = {
    model: {
      scenarios: model.scenarioIds.length,
      points: model.points.map(point => ({
        point,
        language: model.languages[point],
        minimum: model.minimum[point],
        transferCost: model.transferCost[point],
        uncovered: model.uncoveredPoints.includes(point)
      })),
      workers: model.workers.length,
      assignableWorkers: assignableWorkers(model).length,
      minutesPerWorker: model.minutesPerWorker,
      uncoveredPoints: model.uncoveredPoints
    },
    settings: {
      budget,
      alpha,
      riskWeight,
      objective: 'expectedShortfall + riskWeight * cvar(alpha)',
      weightSum: model.weightSum,
      weightSemantics: model.weightSemantics
    },
    riskInterpretation: model.probabilityInterpretation
      ? '情景权重已声明为预测概率；CVaR 可按概率尾部解释。'
      : '情景权重是给定情景的规划权重，不是预测概率；CVaR 只作离散情景的加权尾部平均，拒绝概率化风险解释。',
    weightsAreProbabilities: model.probabilityInterpretation
  };

  if (!risk.plan) {
    if (!risk.search.proven) {
      // 搜索被截断且尚未找到可行方案：只报告搜索界限，不宣称不可行。
      return {
        ...context,
        feasible: null,
        feasibility: 'undetermined',
        conflicts: [],
        search: risk.search,
        bestKnownPlan: null,
        managerBrief: {
          headline: '搜索在时限或节点上限内未找到可行分配，且未完成证明；'
            + '不要据此断定预算或最低保障不可行。请放宽搜索界限或核对配置。',
          conflicts: []
        }
      };
    }
    const conflicts = infeasibilityConflicts(model, budget);
    return {
      ...context,
      feasible: false,
      feasibility: 'infeasible',
      conflicts,
      search: risk.search,
      bestKnownPlan: null,
      managerBrief: {
        headline: '当前预算与最低保障组合不可行，没有可执行分配。',
        conflicts: conflicts.map(conflict => conflict.detail)
      }
    };
  }

  const average = solve(model, { budget, alpha, riskWeight: 0, search });
  const averagePlan = average.plan;
  const riskPlan = risk.plan;
  const comparison = averagePlan === null
    ? null : compareForManager(averagePlan, riskPlan, model, riskWeight);
  const marginal = marginalWorker(model, riskPlan, budget, alpha, riskWeight, search);
  const result = {
    ...context,
    feasible: true,
    feasibility: 'feasible',
    objectiveFormula: 'expectedShortfall + riskWeight * cvar(alpha)',
    averageOptimal: averagePlan === null ? null : describePlan(averagePlan),
    riskAverse: describePlan(riskPlan),
    comparison,
    comparisonNote: averagePlan === null
      ? '平均缺口最优搜索在给定界限内未找到方案，因此没有可比的平均最优方案。'
      : null,
    marginalWorker: marginal,
    search: { average: average.search, risk: risk.search },
    constraints: {
      budget: {
        limit: budget,
        used: riskPlan.totalAssigned,
        satisfied: riskPlan.totalAssigned <= budget
      },
      minimum: model.points.filter(point => model.minimum[point] > 0).map(point => ({
        point,
        required: model.minimum[point],
        assigned: riskPlan.headcount[point],
        satisfied: riskPlan.headcount[point] >= model.minimum[point]
      }))
    }
  };
  result.managerBrief = managerBrief(result);
  return result;
}
