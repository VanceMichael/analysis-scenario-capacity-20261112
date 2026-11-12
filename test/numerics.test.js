import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('服务点内情景清点不把重复记录变成独立世界', () => {

  assert.equal(probe([{scenario: 'a'}, {scenario: 'a'}, {scenario: 'b'}]).scenarios, 2);
  assert.equal(probe([{scenario: 'a', demand: 0}]).scenarios, 1);
});
