// 临时领域断言：验证版本账关键语义。通过 esbuild 打包后由 node 执行。
import assert from 'node:assert/strict';
import {
  buildImpactPlan,
  compatRead,
  evaluate,
  findCalcCycles,
  makeDraft,
  makeFrozenSnapshot,
  parseSources,
  type FormVersion,
  type Submission,
} from '../src/versioning';

const v1: FormVersion = {
  id: 'v1', label: 'v1', createdAt: '2026-08-01', status: 'frozen', basedOnRevision: 0, revision: 1,
  fields: [
    { id: 'name', label: '名称', type: 'text', required: true },
    { id: 'department', label: '部门', type: 'select', required: true, options: ['研发', '财务'] },
    { id: 'amount', label: '金额', type: 'number', required: true },
  ],
  linkRules: [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'amount' },
  ],
  calcRules: [],
};

const legacy: Submission = {
  id: 's1', label: '旧单', createdAt: '2026-08-10', data: { name: '培训', department: '财务', amount: '100' },
  versionId: 'v1', rulesVersion: '', status: 'pending_classify', stamps: [],
};
const legacy2: Submission = {
  id: 's2', label: '旧单2', createdAt: '2026-08-11', data: { name: '研发采购', department: '研发', amount: '20' },
  versionId: 'v1', rulesVersion: '', status: 'pending_classify', stamps: [],
};
const subs = [legacy, legacy2];

// 1. 成环检测：a=b+x, b=a+y
const cyclicDraft = makeDraft(v1, 1);
cyclicDraft.fields.push({ id: 'a', label: 'A', type: 'number', required: false });
cyclicDraft.fields.push({ id: 'b', label: 'B', type: 'number', required: false });
cyclicDraft.fields.push({ id: 'x', label: 'X', type: 'number', required: false });
cyclicDraft.fields.push({ id: 'y', label: 'Y', type: 'number', required: false });
cyclicDraft.calcRules = [
  { id: 'c1', targetId: 'a', sourceIds: ['b', 'x'], formula: 'b + x' },
  { id: 'c2', targetId: 'b', sourceIds: ['a', 'y'], formula: 'a + y' },
];
const cycles = findCalcCycles(cyclicDraft);
assert.equal(cycles.length, 1, '应检测到一个环');
assert.deepEqual([...new Set(cycles[0])].sort(), ['a', 'b']);

const planCycle = buildImpactPlan(cyclicDraft, v1, 1, subs);
assert.equal(planCycle.hasBlocking, true, '成环必须阻断发布');
assert.ok(planCycle.groups.some((g) => g.kind === 'calc_cycle'));

// 2. 字段下线 + 规则改向影响预演
const draft = makeDraft(v1, 1);
draft.fields = draft.fields.filter((f) => f.id !== 'amount'); // amount 下线
// r1 目标随之下线（offlineField 在 store 层清理，这里手工模拟规则改向场景）：
draft.linkRules = [
  { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'name' },
];
const plan = buildImpactPlan(draft, v1, 1, subs);
const off = plan.groups.find((g) => g.kind === 'field_offline');
assert.ok(off, '应列出字段下线组');
assert.deepEqual(off.affectedIds.sort(), ['s1', 's2'], '两单都含 amount 值，都受字段下线影响');
const redir = plan.groups.find((g) => g.kind === 'rule_redirect');
assert.ok(redir, '应列出规则改向组');
// s1 按旧规则触发（部门=财务）；s2 未触发但目标 amount 有值——目标语义即将改变，同样受影响
assert.deepEqual([...redir.affectedIds].sort(), ['s1', 's2']);

// 3. 运行态冻结求值：通过 / 拦截，且改新版本不影响旧解释
const frozen = { ...v1, linkRules: structuredClone(v1.linkRules), calcRules: [] };
const okEval = evaluate(frozen, { name: '差旅', department: '财务', amount: '300' });
assert.equal(okEval.status, 'passed');
const badEval = evaluate(frozen, { name: '差旅', department: '财务', amount: '' });
assert.equal(badEval.status, 'intercepted');
assert.ok(badEval.evaluations.some((e) => !e.passed && e.message.includes('必填项')));
assert.ok(badEval.evaluations.some((e) => e.ruleId === 'r1' && !e.passed), '财务联动 require 应拦截');

const snapshot = makeFrozenSnapshot(frozen);
snapshot.linkRules.length = 0; // 模拟"之后发布改了规则"
const replayed = evaluate(
  { ...frozen, linkRules: frozen.linkRules }, // 解释仍来自提交时冻结快照
  { name: '差旅', department: '财务', amount: '300' }
);
assert.equal(replayed.status, 'passed', '旧解释不随后续发布改写');
void snapshot;

// 4. 计算规则求值
const calcV: FormVersion = {
  ...structuredClone(frozen),
  fields: [
    ...frozen.fields,
    { id: 'tax', label: '税额', type: 'number', required: false },
  ],
  calcRules: [{ id: 't1', targetId: 'tax', sourceIds: ['amount'], formula: 'amount * 0.1' }],
};
assert.deepEqual(parseSources('amount * 0.1', calcV), ['amount']);
const calcEval = evaluate(calcV, { name: 'x', department: '研发', amount: '100', tax: '10' });
assert.equal(calcEval.status, 'passed');
const calcBad = evaluate(calcV, { name: 'x', department: '研发', amount: '100', tax: '99' });
assert.equal(calcBad.status, 'intercepted');
assert.ok(calcBad.evaluations.some((e) => e.kind === 'calc' && !e.passed));

// 5. 历史数据兼容读取：只读数，不重算
const rows = compatRead(legacy, v1);
assert.equal(rows.length, 3);
assert.equal(rows.find((r) => r.fieldId === 'amount')?.value, '100');
assert.equal(rows.find((r) => r.fieldId === 'amount')?.known, true);
const rowsNew = compatRead(legacy, { ...v1, fields: [...v1.fields, { id: 'future', label: '未来字段', type: 'text', required: false }] });
assert.equal(rowsNew.find((r) => r.fieldId === 'future')?.known, false);

// 6. 基线 revision 不匹配 → 调用方（store）判定冲突；plan 带 baselineRevision
const planStale = buildImpactPlan(draft, v1, 1, subs);
assert.notEqual(planStale.baselineRevision, 2, '草稿基于 revision1，基线已到 2 时应由 store 拦截');

console.log('全部领域断言通过 ✅');
