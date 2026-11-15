import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { analyze, buildModel } from './capacity.js';
import { loadPolicy } from './policy.js';

const COMMANDS = ['summary', 'inspect', 'capacity'];
const OPTIONS = { '--input': 'input', '--policy': 'policy', '--out': 'out', '--budget': 'budget' };
const CAPACITY_ONLY = new Set(['policy', 'budget', 'requireProbability']);

const USAGE = '命令应为 summary、inspect 或 capacity；'
  + '可选参数为 --input 路径、--out 路径；capacity 另接受 --policy 路径、'
  + '--budget 非负整数和 --require-probability';

function parseInteger(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} 必须是非负整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} 超出安全整数范围`);
  return number;
}

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  const result = { command, input: 'data/records.json' };
  if (command === 'capacity') result.policy = 'data/policy.json';
  for (let index = 0; index < options.length; index += 1) {
    const name = options[index];
    if (name === '--require-probability') {
      if (result.requireProbability) throw new Error('参数不可重复');
      result.requireProbability = true;
      continue;
    }
    const value = options[index + 1];
    if (!Object.hasOwn(OPTIONS, name) || !value || value.startsWith('--')) throw new Error(USAGE);
    index += 1;
    const key = OPTIONS[name];
    if (key === 'budget') {
      if (result.budget !== undefined) throw new Error('参数不可重复');
      result.budget = parseInteger(value, name);
    } else {
      if (key === 'out' && result.out !== undefined) throw new Error('参数不可重复');
      result[key] = value;
    }
  }
  if (command !== 'capacity') {
    for (const key of CAPACITY_ONLY) {
      if (result[key] !== undefined) throw new Error(`${USAGE}；该参数只用于 capacity`);
    }
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let result;
  if (options.command === 'capacity') {
    const policy = await loadPolicy(options.policy);
    const settings = {};
    if (options.budget !== undefined) settings.budget = options.budget;
    if (options.requireProbability) settings.requireProbability = true;
    result = analyze(buildModel(dataset.records, policy), settings);
  } else if (options.command === 'summary') {
    result = summarize(dataset.records);
  } else {
    result = {
      records: dataset.records.length,
      fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : []
    };
  }
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
