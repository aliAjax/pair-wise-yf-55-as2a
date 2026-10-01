// 版本账领域内核：影响预演、计算依赖环检测、运行态规则引擎、历史兼容读取。
// 所有解释都基于"某条申请保存时的冻结版本"生成，后续发布不会回头改写。

export type FieldType = 'text' | 'number' | 'select' | 'date';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface LinkRule {
  id: string;
  fieldId: string; // 触发字段
  operator: 'equals' | 'notEmpty';
  value: string;
  effect: 'show' | 'require';
  targetId: string; // 被影响字段
}

export interface CalcRule {
  id: string;
  targetId: string; // 计算结果字段
  sourceIds: string[]; // 依赖字段（由公式解析）
  formula: string; // 仅支持 字段id 与 + - * / ( ) 数字
}

export type VersionStatus = 'frozen' | 'draft';

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  status: VersionStatus;
  fields: FormField[];
  linkRules: LinkRule[];
  calcRules: CalcRule[];
  basedOnRevision: number; // 草稿分叉时的基线 revision
  revision?: number; // 冻结版本写入基线时的 revision
}

export interface RuleEvaluation {
  ruleId: string;
  kind: 'required' | 'link' | 'calc' | 'schema';
  description: string;
  triggered: boolean;
  passed: boolean;
  message: string;
}

export type ValidationStatus = 'passed' | 'intercepted' | 'pending_classify' | 'classified';

export interface FrozenRulesSnapshot {
  linkRules: LinkRule[];
  calcRules: CalcRule[];
}

export interface ImpactStamp {
  at: string;
  jobId: string;
  fromVersionId: string;
  toVersionId: string;
  kinds: ImpactKind[];
  detail: string;
}

export interface Classification {
  at: string;
  mappedVersionId: string;
  note: string;
}

export interface Submission {
  id: string;
  label: string;
  createdAt: string;
  data: Record<string, string>;
  versionId: string; // 结构版本；历史数据可能为空串
  rulesVersion: string; // 规则版本（冻结快照键）；缺失即为待归类
  frozenRules?: FrozenRulesSnapshot;
  validation?: {
    status: Extract<ValidationStatus, 'passed' | 'intercepted'>;
    evaluatedAt: string;
    evaluations: RuleEvaluation[];
  };
  status: ValidationStatus;
  stamps: ImpactStamp[];
  classification?: Classification;
}

export type ImpactKind = 'field_offline' | 'rule_redirect' | 'calc_cycle' | 'new_required';

export interface ImpactItem {
  key: string;
  title: string;
}

export interface ImpactGroup {
  kind: ImpactKind;
  title: string;
  blocking: boolean;
  items: ImpactItem[];
  affectedIds: string[]; // 受影响存量申请 id
}

export interface ImpactPlan {
  baselineId: string;
  draftId: string;
  baselineRevision: number;
  groups: ImpactGroup[];
  cycles: string[][];
  affectedIds: string[];
  affectedCount: number;
  hasBlocking: boolean;
}

// ---------- 存储键：基线跨标签页共享，草稿/发布任务按标签页隔离 ----------

export const LS_BASELINE = 'yf55-baseline-v2';
export const LS_LEGACY = 'yf55-schema-state';
const SS_TAB_ID = 'yf55-tab-id';
const SS_DRAFT = 'yf55-draft-v2';
const SS_JOB = 'yf55-job-v2';

export function getTabId(): string {
  if (typeof sessionStorage === 'undefined') return 'server';
  let id = sessionStorage.getItem(SS_TAB_ID);
  if (!id) {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(SS_TAB_ID, id);
  }
  return id;
}

export function readDraft(): FormVersion | null {
  const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SS_DRAFT);
  return raw ? (JSON.parse(raw) as FormVersion) : null;
}
export function writeDraft(draft: FormVersion | null) {
  if (typeof sessionStorage === 'undefined') return;
  if (draft) sessionStorage.setItem(SS_DRAFT, JSON.stringify(draft));
  else sessionStorage.removeItem(SS_DRAFT);
}
export function readJobState(): PublishJobRef | null {
  const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SS_JOB);
  return raw ? (JSON.parse(raw) as PublishJobRef) : null;
}
export function writeJobState(job: PublishJob | null) {
  if (typeof sessionStorage === 'undefined') return;
  if (job) sessionStorage.setItem(SS_JOB, JSON.stringify(job));
  else sessionStorage.removeItem(SS_JOB);
}

// ---------- 发布任务（写入账） ----------

export type WriteItemStatus = 'pending' | 'done' | 'failed';
export interface WriteItem {
  id: string;
  kind: 'freeze_version' | 'stamp_submission';
  label: string;
  refId?: string;
  status: WriteItemStatus;
  error?: string;
}
export type JobStatus = 'writing' | 'failed' | 'conflict' | 'done';
export interface PublishJob {
  id: string;
  newVersionId: string;
  newVersionLabel: string;
  draftId: string;
  draftLabel: string;
  baseRevision: number;
  plan: ImpactPlan;
  items: WriteItem[];
  status: JobStatus;
  conflictActualRevision?: number;
  startedAt: string;
  simulateFailure?: boolean; // 演示：冻结落账后让第一项影响登记失败
}
// 失败后刷新页面时的恢复引用
export type PublishJobRef = PublishJob;

// ---------- 基线单据 ----------

export interface BaselineDoc {
  revision: number;
  seq: number;
  activeVersionId: string;
  frozenVersions: FormVersion[];
  submissions: Submission[];
}

// ---------- 描述与规则求值 ----------

export const fieldLabelOf = (v: Pick<FormVersion, 'fields'>, id: string): string =>
  v.fields.find((f) => f.id === id)?.label ?? id;

export function describeLinkRule(rule: LinkRule, v: Pick<FormVersion, 'fields'>): string {
  const cond =
    rule.operator === 'equals'
      ? `当「${fieldLabelOf(v, rule.fieldId)}」等于「${rule.value}」时`
      : `当「${fieldLabelOf(v, rule.fieldId)}」非空时`;
  return `${cond}，${rule.effect === 'require' ? '要求填写' : '显示'}「${fieldLabelOf(v, rule.targetId)}」`;
}

export function describeCalcRule(rule: CalcRule, v: Pick<FormVersion, 'fields'>): string {
  const expr = rule.formula || rule.sourceIds.join(' + ');
  return `计算字段「${fieldLabelOf(v, rule.targetId)}」= ${expr}`;
}

function linkTriggered(rule: LinkRule, data: Record<string, string>): boolean {
  const raw = String(data[rule.fieldId] ?? '').trim();
  return rule.operator === 'notEmpty' ? raw !== '' : raw === rule.value;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

export function parseSources(formula: string, v: Pick<FormVersion, 'fields'>): string[] {
  const ids = new Set(v.fields.map((f) => f.id));
  return [...new Set(formula.match(IDENT) ?? [])].filter((token) => ids.has(token));
}

export function evalFormula(
  formula: string,
  data: Record<string, string>,
  v: Pick<FormVersion, 'fields'>
): { ok: boolean; value?: number; error?: string } {
  const known = new Set(v.fields.map((f) => f.id));
  const tokens = formula.match(IDENT) ?? [];
  const unknown = tokens.find((token) => !known.has(token));
  if (unknown) return { ok: false, error: `公式引用了不存在的字段：${unknown}` };
  const expr = formula.replace(IDENT, (token) => {
    const n = Number(String(data[token] ?? 0));
    return Number.isFinite(n) ? String(n) : '0';
  });
  if (!/^[\d+\-*/().\s]+$/.test(expr)) return { ok: false, error: '公式只支持 + - * / 与括号' };
  try {
    // 仅包含数字与算术运算符，来源字段已白名单校验
    const value = Function(`"use strict";return (${expr});`)() as unknown;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: '计算结果不是有效数字' };
    return { ok: true, value };
  } catch {
    return { ok: false, error: '公式无法计算' };
  }
}

// target 依赖 sources；沿 target -> sources 找环（source 只要是本表单字段且有计算出边即可参与成环）
export function findCalcCycles(v: Pick<FormVersion, 'calcRules' | 'fields'>): string[][] {
  const fieldIds = new Set(v.fields.map((f) => f.id));
  const edges = new Map<string, string[]>();
  for (const rule of v.calcRules) {
    const prev = edges.get(rule.targetId) ?? [];
    edges.set(rule.targetId, [...new Set([...prev, ...rule.sourceIds.filter((s) => fieldIds.has(s))])]);
  }
  const nodes = new Set<string>([...edges.keys(), ...[...edges.values()].flat()]);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string) => {
    color.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const key = [...new Set(cycle)].sort().join('>');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (c === 0) visit(next);
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const t of nodes) if (!color.has(t)) visit(t);
  return cycles;
}

// 运行态：按某版本的冻结规则求值，生成逐条解释
export function evaluate(
  v: FormVersion,
  data: Record<string, string>
): { status: 'passed' | 'intercepted'; evaluations: RuleEvaluation[] } {
  const evaluations: RuleEvaluation[] = [];

  for (const field of v.fields) {
    const raw = String(data[field.id] ?? '').trim();
    if (field.required) {
      evaluations.push({
        ruleId: `req-${field.id}`,
        kind: 'required',
        description: `必填校验：「${field.label}」`,
        triggered: raw === '',
        passed: raw !== '',
        message: raw === '' ? `拦截：必填项「${field.label}」未填写` : `已填写「${field.label}」`,
      });
    }
    if (field.type === 'select' && field.options?.length && raw !== '' && !field.options.includes(raw)) {
      evaluations.push({
        ruleId: `opt-${field.id}`,
        kind: 'schema',
        description: `选项校验：「${field.label}」`,
        triggered: true,
        passed: false,
        message: `拦截：「${field.label}」的值 ${raw} 不在当前选项内`,
      });
    }
  }

  for (const rule of v.linkRules) {
    const triggered = linkTriggered(rule, data);
    const targetRaw = String(data[rule.targetId] ?? '').trim();
    if (rule.effect === 'require') {
      const passed = !(triggered && targetRaw === '');
      evaluations.push({
        ruleId: rule.id,
        kind: 'link',
        description: describeLinkRule(rule, v),
        triggered,
        passed,
        message: !triggered
          ? '条件未触发，不要求填写'
          : passed
            ? `条件已触发，「${fieldLabelOf(v, rule.targetId)}」已填写`
            : `拦截：${describeLinkRule(rule, v)}，但「${fieldLabelOf(v, rule.targetId)}」为空`,
      });
    } else {
      evaluations.push({
        ruleId: rule.id,
        kind: 'link',
        description: describeLinkRule(rule, v),
        triggered,
        passed: true,
        message: triggered
          ? `条件已触发，显示「${fieldLabelOf(v, rule.targetId)}」`
          : `条件未触发，隐藏「${fieldLabelOf(v, rule.targetId)}」`,
      });
    }
  }

  for (const rule of v.calcRules) {
    const result = evalFormula(rule.formula, data, v);
    const actual = Number(String(data[rule.targetId] ?? '').trim());
    const passed = result.ok && Number.isFinite(actual) && Math.abs(actual - (result.value as number)) < 1e-6;
    evaluations.push({
      ruleId: rule.id,
      kind: 'calc',
      description: describeCalcRule(rule, v),
      triggered: true,
      passed,
      message: !result.ok
        ? `规则无法执行：${result.error}`
        : `期望值 ${result.value}，提交值 ${Number.isFinite(actual) ? actual : '空'}`,
    });
  }

  const status = evaluations.some((e) => !e.passed) ? 'intercepted' : 'passed';
  return { status, evaluations };
}

// ---------- 影响预演 ----------

const KIND_TITLE: Record<ImpactKind, string> = {
  field_offline: '字段下线',
  rule_redirect: '规则改向 / 失效',
  calc_cycle: '计算依赖成环',
  new_required: '新增必填（迁移缺口）',
};

function group(
  kind: ImpactKind,
  items: ImpactItem[],
  affectedIds: string[],
  blocking = false
): ImpactGroup | null {
  if (!items.length && !affectedIds.length) return null;
  return { kind, title: KIND_TITLE[kind], blocking, items, affectedIds: [...new Set(affectedIds)] };
}

export function buildImpactPlan(
  draft: FormVersion,
  baseline: FormVersion,
  baselineRevision: number,
  submissions: Submission[]
): ImpactPlan {
  const groups: ImpactGroup[] = [];
  const baseFields = new Map(baseline.fields.map((f) => [f.id, f]));
  const draftFields = new Map(draft.fields.map((f) => [f.id, f]));

  // 1) 字段下线
  const offlineItems: ImpactItem[] = [];
  const offlineAffected: string[] = [];
  for (const [id, field] of baseFields) {
    if (draftFields.has(id)) continue;
    offlineItems.push({ key: id, title: `字段「${field.label}」（${id}）已下线` });
    for (const s of submissions) {
      if (String(s.data[id] ?? '').trim() !== '') offlineAffected.push(s.id);
    }
  }
  const offlineGroup = group('field_offline', offlineItems, offlineAffected);
  if (offlineGroup) groups.push(offlineGroup);

  // 2) 规则改向（同 id 规则的触发字段/算符/取值/效果/目标任一变化，或被删除 / 引用字段下线）
  const redirectItems: ImpactItem[] = [];
  const redirectAffected: string[] = [];
  const draftRules = new Map(draft.linkRules.map((r) => [r.id, r]));
  for (const oldRule of baseline.linkRules) {
    const newRule = draftRules.get(oldRule.id);
    let changed = false;
    let reason = '';
    if (!newRule) {
      changed = true;
      reason = '规则已删除';
    } else if (!draftFields.has(oldRule.fieldId) || !draftFields.has(oldRule.targetId)) {
      changed = true;
      reason = '规则引用的字段已下线，规则失效';
    } else if (
      newRule.fieldId !== oldRule.fieldId ||
      newRule.operator !== oldRule.operator ||
      newRule.value !== oldRule.value ||
      newRule.effect !== oldRule.effect ||
      newRule.targetId !== oldRule.targetId
    ) {
      changed = true;
      reason = `改向：${describeLinkRule(newRule, draft)}`;
    }
    if (!changed) continue;
    redirectItems.push({ key: oldRule.id, title: `${describeLinkRule(oldRule, baseline)} → ${reason}` });
    // 按旧规则条件会被触发的存量申请即为受影响单据
    for (const s of submissions) {
      if (linkTriggered(oldRule, s.data) || String(s.data[oldRule.targetId] ?? '') !== '') {
        redirectAffected.push(s.id);
      }
    }
  }
  const redirectGroup = group('rule_redirect', redirectItems, redirectAffected);
  if (redirectGroup) groups.push(redirectGroup);

  // 3) 计算依赖成环（阻断发布）
  const cycles = findCalcCycles(draft);
  if (cycles.length) {
    const cycleNodes = new Set(cycles.flat());
    const items: ImpactItem[] = cycles.map((cycle, i) => ({
      key: `cycle-${i}`,
      title: `成环：${cycle.map((id) => fieldLabelOf(draft, id)).join(' → ')}`,
    }));
    const affected = submissions
      .filter((s) => [...cycleNodes].some((id) => String(s.data[id] ?? '').trim() !== ''))
      .map((s) => s.id);
    groups.push(group('calc_cycle', items, affected, true) as ImpactGroup);
  }

  // 4) 新增必填字段的迁移缺口（信息项，不阻断）
  const gapItems: ImpactItem[] = [];
  const gapAffected: string[] = [];
  for (const [id, field] of draftFields) {
    if (!field.required || baseFields.has(id)) continue;
    gapItems.push({ key: id, title: `新增必填字段「${field.label}」` });
    for (const s of submissions) {
      if (String(s.data[id] ?? '').trim() === '') gapAffected.push(s.id);
    }
  }
  const gapGroup = group('new_required', gapItems, gapAffected);
  if (gapGroup) groups.push(gapGroup);

  const affectedIds = [...new Set(groups.flatMap((g) => g.affectedIds))];
  return {
    baselineId: baseline.id,
    draftId: draft.id,
    baselineRevision,
    groups,
    cycles,
    affectedIds,
    affectedCount: affectedIds.length,
    hasBlocking: groups.some((g) => g.blocking),
  };
}

// ---------- 历史数据兼容读取 ----------

export function isLegacyUnversioned(raw: Partial<Submission> | null | undefined): boolean {
  return !raw || !raw.rulesVersion;
}

// 缺规则版本：按原表单（映射到最老冻结版本）兼容读取，只给字段读数，不产出校验结论
export function compatRead(
  s: Pick<Submission, 'data'>,
  mapped: FormVersion
): { fieldId: string; label: string; value: string; known: boolean }[] {
  return mapped.fields.map((f) => ({
    fieldId: f.id,
    label: f.label,
    value: String(s.data[f.id] ?? ''),
    known: f.id in s.data,
  }));
}

// 账上数据都是 JSON 结构；reducer 入参可能是 immer draft 代理，structuredClone 会失败，统一走 JSON 克隆
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeFrozenSnapshot(v: FormVersion): FrozenRulesSnapshot {
  return { linkRules: cloneJson(v.linkRules), calcRules: cloneJson(v.calcRules) };
}

// ---------- 草稿 ----------

export function makeDraft(base: FormVersion, revision: number): FormVersion {
  const now = new Date();
  return {
    ...cloneJson(base),
    id: `draft-${now.getTime()}`,
    label: `草稿 · 基于 ${base.label}`,
    createdAt: now.toISOString().slice(0, 10),
    status: 'draft',
    basedOnRevision: revision,
    revision: undefined,
  };
}

export const today = () => new Date().toISOString().slice(0, 10);
export const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function impactKindLabel(kind: ImpactKind): string {
  return KIND_TITLE[kind];
}
