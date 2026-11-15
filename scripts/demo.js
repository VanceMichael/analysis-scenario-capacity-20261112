import { readFile } from 'node:fs/promises';
import { main } from '../src/cli.js';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有按服务点核算');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置（人员、班次可用性、最低保障、跨点调动成本）');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));
console.log('容量建议：平均损失最优、风险厌恶方案、多一名人员与搜索界');
const capacity = await main(['capacity', '--out', 'var/capacity.json']);
console.log(JSON.stringify({
  feasible: capacity.feasible,
  settings: capacity.settings,
  riskInterpretation: capacity.riskInterpretation,
  managerBrief: capacity.managerBrief,
  averageOptimal: {
    headcount: capacity.averageOptimal.headcount,
    expectedShortfall: capacity.averageOptimal.expectedShortfall,
    cvar: capacity.averageOptimal.cvar,
    objective: capacity.averageOptimal.objective
  },
  riskAverse: {
    headcount: capacity.riskAverse.headcount,
    expectedShortfall: capacity.riskAverse.expectedShortfall,
    cvar: capacity.riskAverse.cvar,
    objective: capacity.riskAverse.objective
  },
  comparison: capacity.comparison,
  marginalWorker: {
    available: capacity.marginalWorker.available,
    feasible: capacity.marginalWorker.feasible,
    headcountChange: capacity.marginalWorker.headcountChange,
    expectedShortfallChange: capacity.marginalWorker.expectedShortfallChange,
    cvarChange: capacity.marginalWorker.cvarChange,
    search: capacity.marginalWorker.search
  },
  search: capacity.search,
  tailMembers: capacity.riskAverse.tail.members.map(member => ({
    scenario: member.id,
    loss: member.loss,
    inclusionFraction: member.inclusionFraction
  }))
}, null, 2));
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
