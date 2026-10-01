// store 层发布账断言：localStorage 模拟浏览器，直接驱动 reducer。
import assert from 'node:assert/strict';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
(globalThis as { localStorage?: MemoryStorage }).localStorage = new MemoryStorage();
(globalThis as { sessionStorage?: MemoryStorage }).sessionStorage = new MemoryStorage();

const { store, actions } = await import('./store-bundle');
const {
  addField,
  ensureDraft,
  runImpactPreview,
  confirmPublish,
  driveJob,
  retryJob,
  baselineChanged,
  rebasePlan,
  classifySubmission,
  submitRuntime,
  offlineField,
  upsertCalcRule,
} = actions;

function state() {
  return store.getState().schema;
}

// 初始：1 个冻结版本 + 2 单待归类
assert.equal(state().baseline.frozenVersions.length, 1);
assert.equal(state().baseline.submissions.length, 2);
assert.equal(state().baseline.revision, 1);

// 编辑草稿：下线 amount（影响两单）
store.dispatch(ensureDraft());
store.dispatch(offlineField({ id: 'amount' }));
store.dispatch(runImpactPreview());
const plan = state().plan!;
assert.deepEqual([...plan.affectedIds].sort(), ['s1', 's2']);
assert.equal(plan.hasBlocking, false);

// 正常发布
store.dispatch(confirmPublish());
store.dispatch(driveJob());
const job = state().job!;
assert.equal(job.status, 'done', '发布应完成');
assert.equal(state().baseline.revision, 2);
assert.equal(state().baseline.frozenVersions.length, 2);
assert.equal(state().baseline.activeVersionId, 'v2');
assert.equal(state().draft, null, '完成后草稿清理');
// 两单追加影响戳记，旧解释（无 validation）未被生成
for (const s of state().baseline.submissions) {
  assert.equal(s.stamps.length, 1);
  assert.deepEqual(s.stamps[0].kinds, ['field_offline']);
  assert.equal(s.validation, undefined, '发布绝不回填旧单校验结果');
  assert.equal(s.status, 'pending_classify');
}

// 归类只补解释
store.dispatch(classifySubmission({ id: 's1', note: '人工核实：历史财务单', mappedVersionId: 'v1' }));
const s1 = state().baseline.submissions.find((x) => x.id === 's1')!;
assert.equal(s1.status, 'classified');
assert.equal(s1.validation, undefined, '归类不能重算原结果');
assert.equal(s1.classification?.note, '人工核实：历史财务单');

// 运行态提交：冻结规则版本 + 校验结果
store.dispatch(submitRuntime({
  id: 'sub-x', label: '运行态单',
  data: { name: '新申请', department: '研发' }, // v2 里 amount 已下线，无需提供
}));
const sub = state().baseline.submissions.find((x) => x.id === 'sub-x')!;
assert.equal(sub.rulesVersion, 'v2@r2');
assert.ok(sub.frozenRules);
assert.ok(sub.validation);
const dataBefore = JSON.stringify(sub.validation.evaluations);

// 再发 v3，旧单解释不变
store.dispatch(ensureDraft());
store.dispatch(runImpactPreview());
store.dispatch(confirmPublish());
store.dispatch(driveJob());
assert.equal(state().baseline.revision, 3);
const subAfter = state().baseline.submissions.find((x) => x.id === 'sub-x')!;
assert.equal(JSON.stringify(subAfter.validation!.evaluations), dataBefore, '后续发布不改写旧解释');
assert.equal(subAfter.rulesVersion, 'v2@r2');

// ---- 失败保留清单 + 重试只处理未完成项 ----
// 构造有影响的草稿：再下线一个字段
store.dispatch(ensureDraft());
store.dispatch(offlineField({ id: 'name' }));
store.dispatch(runImpactPreview());
assert.ok(state().plan!.affectedCount >= 2);
store.dispatch(confirmPublish({ simulateFailure: true }));
store.dispatch(driveJob());
const failedJob = state().job!;
assert.equal(failedJob.status, 'failed');
const freezeItem = failedJob.items.find((i) => i.kind === 'freeze_version')!;
assert.equal(freezeItem.status, 'done', '冻结版应已落账');
const failedItems = failedJob.items.filter((i) => i.status === 'failed');
assert.equal(failedItems.length, 1, '恰好一项影响登记失败');
const revAfterFreeze = state().baseline.revision;
assert.equal(revAfterFreeze, 4, '冻结成功即推进 revision');

// 重试：只处理未完成项
store.dispatch(retryJob());
store.dispatch(driveJob());
const retried = state().job!;
assert.equal(retried.status, 'done');
assert.ok(retried.items.every((i) => i.status === 'done'));
// 戳记不重复：每单最多一条该 job 的戳记
for (const s of state().baseline.submissions) {
  const mine = s.stamps.filter((t) => t.jobId === retried.id);
  assert.ok(mine.length <= 1, '重试幂等：戳记不重复');
}

// ---- 并发：后提交的按最新基线冲突，草稿保留不覆盖 ----
store.dispatch(ensureDraft());
store.dispatch(runImpactPreview());
const baseRev = state().baseline.revision;
// 模拟另一标签页刚发布了更新的基线（storage 事件）
const otherDoc = structuredClone(state().baseline);
otherDoc.revision = baseRev + 1;
store.dispatch(baselineChanged(otherDoc));
store.dispatch(confirmPublish());
// confirmPublish 检测到 revision 不匹配：不建 job（plan 被重算），草稿保留
assert.notEqual(state().draft, null, '冲突时草稿保留');
assert.equal(state().baseline.frozenVersions.length, otherDoc.frozenVersions.length, '未覆盖已发布版本');
// 按最新基线重新预演后可再发布
store.dispatch(rebasePlan());
store.dispatch(runImpactPreview());
store.dispatch(confirmPublish());
store.dispatch(driveJob());
assert.equal(state().job?.status, 'done', '重基线后发布成功');

// ---- 成环阻断（此时 name 已被前面发布下线，用新增字段构造环） ----
store.dispatch(ensureDraft());
store.dispatch(actions.addField());
const cycleFieldId = state().draft!.fields.find((f) => f.label === '新字段')!.id;
store.dispatch(upsertCalcRule({ id: 'ca', targetId: cycleFieldId, sourceIds: ['department'], formula: 'department' }));
store.dispatch(upsertCalcRule({ id: 'cb', targetId: 'department', sourceIds: [cycleFieldId], formula: cycleFieldId }));
store.dispatch(runImpactPreview());
assert.equal(state().plan!.hasBlocking, true);
const versionCountBefore = state().baseline.frozenVersions.length;
const jobBeforeCycle = state().job;
store.dispatch(confirmPublish());
store.dispatch(driveJob());
assert.equal(state().job, jobBeforeCycle, '阻断时不产生发布任务');
assert.equal(state().baseline.frozenVersions.length, versionCountBefore, '成环未新增版本');

console.log('全部 store 发布账断言通过 ✅');
