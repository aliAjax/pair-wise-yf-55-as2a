import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';

// ---------- 类型 ----------
export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; offline?: boolean; }
export type RuleEffect = 'show' | 'require' | 'compute';
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: RuleEffect; targetId: string; }
export type VersionStatus = 'draft' | 'published';
export interface FormVersion { id: string; label: string; createdAt: string; status: VersionStatus; fields: FormField[]; rules: LinkRule[]; baselineVersionId?: string; publishedAt?: string; }

export interface InterceptReason { ruleId: string; ruleSnapshot: LinkRule | null; message: string; }
export interface FieldValidation { fieldId: string; valid: boolean; reasons: InterceptReason[]; }
export type SubmissionStatus = 'accepted' | 'intercepted';
export type ClassificationStatus = 'pending' | 'classified';
export interface Submission {
  id: string; versionId: string; versionLabel: string; submittedAt: string;
  data: Record<string, unknown>;
  ruleSnapshot: LinkRule[];
  validationResults: FieldValidation[];
  interceptReasons: InterceptReason[];
  status: SubmissionStatus;
  legacy?: boolean;
  classificationStatus?: ClassificationStatus;
  classificationNote?: string;
}

export type ImpactType = 'field-offline' | 'rule-redirect' | 'circular-dependency';
export interface ImpactItem { submissionId: string; submissionLabel: string; type: ImpactType; detail: string; affectedFieldId?: string; affectedRuleId?: string; }
export type PreviewStatus = 'idle' | 'preview' | 'writing' | 'partial' | 'published' | 'conflict' | 'blocked';
export interface ImpactPreview {
  id: string; draftVersionId: string; baselineVersionId: string; createdAt: string;
  items: ImpactItem[]; status: PreviewStatus;
  processedSubmissionIds: string[]; frozenVersionId?: string; faultConsumed?: boolean;
}

interface SchemaState {
  versions: FormVersion[];
  activeVersionId: string;
  previewVersionId: string;
  submissions: Submission[];
  impactPreviews: ImpactPreview[];
  faultInjection: boolean;
}
type RootShape = { schema: SchemaState };

// ---------- 规则引擎 ----------
export function evaluateCondition(rule: LinkRule, data: Record<string, unknown>): boolean {
  if (rule.effect === 'compute') return false;
  const source = data[rule.fieldId];
  if (rule.operator === 'equals') return source != null && String(source) === rule.value;
  if (rule.operator === 'notEmpty') return source !== '' && source != null;
  return false;
}

// 计算依赖成环检测：compute 规则 fieldId -> targetId 构成依赖图
export function detectCycle(rules: LinkRule[]): string[] {
  const graph = new Map<string, string[]>();
  for (const r of rules) {
    if (r.effect === 'compute') {
      if (!graph.has(r.fieldId)) graph.set(r.fieldId, []);
      graph.get(r.fieldId)!.push(r.targetId);
    }
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  let cycle: string[] = [];
  function dfs(node: string, path: string[]): boolean {
    if (stack.has(node)) { cycle = path.slice(path.indexOf(node)); return true; }
    if (visited.has(node)) return false;
    visited.add(node); stack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (dfs(next, [...path, next])) return true;
    }
    stack.delete(node);
    return false;
  }
  for (const node of graph.keys()) { if (dfs(node, [node])) break; }
  return cycle;
}

// 按冻结版本的规则校验运行态数据，结果随提交冻结
export function validateVersion(version: FormVersion, data: Record<string, unknown>): { status: SubmissionStatus; reasons: InterceptReason[]; results: FieldValidation[] } {
  const reasons: InterceptReason[] = [];
  const results: FieldValidation[] = [];
  for (const field of version.fields) {
    if (field.offline) { results.push({ fieldId: field.id, valid: true, reasons: [] }); continue; }
    const fieldReasons: InterceptReason[] = [];
    let required = field.required;
    let visible = true;
    for (const rule of version.rules) {
      if (rule.effect === 'require' && rule.targetId === field.id && evaluateCondition(rule, data)) {
        required = true;
        fieldReasons.push({ ruleId: rule.id, ruleSnapshot: rule, message: `联动规则要求必填：${rule.fieldId} ${rule.operator === 'equals' ? '等于' : '非空'} ${rule.value}` });
      }
      if (rule.effect === 'show' && rule.targetId === field.id && !evaluateCondition(rule, data)) visible = false;
    }
    const value = data[field.id];
    const isEmpty = value === undefined || value === null || value === '';
    const invalid = visible && required && isEmpty;
    if (invalid) {
      if (fieldReasons.length === 0) fieldReasons.push({ ruleId: '__base__', ruleSnapshot: null, message: '基础必填字段未填写' });
      reasons.push(...fieldReasons);
    }
    results.push({ fieldId: field.id, valid: !invalid, reasons: fieldReasons });
  }
  return { status: reasons.length ? 'intercepted' : 'accepted', reasons, results };
}

function submissionLabel(sub: Submission): string {
  return `${sub.versionLabel} · ${sub.submittedAt.slice(0, 16).replace('T', ' ')}`;
}

// 影响预演：比较草稿与基线，列出受影响的存量申请
function computeImpact(draft: FormVersion, baseline: FormVersion | undefined, submissions: Submission[]): ImpactItem[] {
  const items: ImpactItem[] = [];
  for (const sub of submissions) {
    if (sub.legacy) continue;
    for (const field of draft.fields) {
      if (field.offline) {
        const hadData = sub.data[field.id] !== undefined && sub.data[field.id] !== '';
        const wasRequired = baseline?.fields.some((f) => f.id === field.id && f.required) ?? field.required;
        if (hadData || wasRequired) {
          items.push({ submissionId: sub.id, submissionLabel: submissionLabel(sub), type: 'field-offline', detail: `字段「${field.label}」下线，该申请包含其数据或曾为必填`, affectedFieldId: field.id });
        }
      }
    }
    for (const baseRule of baseline?.rules ?? []) {
      const draftRule = draft.rules.find((r) => r.id === baseRule.id);
      const referenced = sub.interceptReasons.some((r) => r.ruleId === baseRule.id) || sub.ruleSnapshot.some((r) => r.id === baseRule.id);
      if (!draftRule) {
        if (referenced) items.push({ submissionId: sub.id, submissionLabel: submissionLabel(sub), type: 'rule-redirect', detail: `规则「${baseRule.id}」被移除，该申请的拦截解释引用了它`, affectedRuleId: baseRule.id });
      } else if (draftRule.fieldId !== baseRule.fieldId || draftRule.operator !== baseRule.operator || draftRule.value !== baseRule.value || draftRule.effect !== baseRule.effect || draftRule.targetId !== baseRule.targetId) {
        if (referenced) items.push({ submissionId: sub.id, submissionLabel: submissionLabel(sub), type: 'rule-redirect', detail: `规则「${baseRule.id}」改向，该申请的拦截解释引用了它`, affectedRuleId: baseRule.id });
      }
    }
  }
  const cycle = detectCycle(draft.rules);
  if (cycle.length) {
    for (const sub of submissions) {
      if (sub.legacy) continue;
      items.push({ submissionId: sub.id, submissionLabel: submissionLabel(sub), type: 'circular-dependency', detail: `计算依赖成环：${cycle.join(' → ')}，版本暂不可发布` });
    }
  }
  return items;
}

// ---------- 初始数据 ----------
const v1fields: FormField[] = [
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'amount', label: '申请金额', type: 'number', required: true }
];
const v2fields: FormField[] = [
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
  { id: 'amount', label: '申请金额', type: 'number', required: true },
  { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
];
const v2rules: LinkRule[] = [
  { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
  { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
];

const v2Version: FormVersion = { id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28', status: 'published', fields: v2fields, rules: v2rules, baselineVersionId: 'v1', publishedAt: '2026-09-28' };

const sub1Data: Record<string, unknown> = { department: '研发', name: '设备采购', budgetCode: 'RD-001', amount: '8000', invoiceDate: '' };
const sub2Data: Record<string, unknown> = { department: '财务', name: '差旅报销', budgetCode: '', amount: '3200', invoiceDate: '' };
const sub1Validation = validateVersion(v2Version, sub1Data);
const sub2Validation = validateVersion(v2Version, sub2Data);

const initial: SchemaState = {
  activeVersionId: 'v2',
  previewVersionId: 'v3',
  versions: [
    { id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12', status: 'published', fields: v1fields, rules: [], publishedAt: '2026-08-12' },
    v2Version,
    { id: 'v3', label: '费用申请 v3（草稿）', createdAt: '2026-09-30', status: 'draft', fields: structuredClone(v2fields), rules: structuredClone(v2rules), baselineVersionId: 'v2' }
  ],
  submissions: [
    // 历史数据：缺少规则版本，按原表单兼容读取，标待归类
    { id: 's1', versionId: 'v1', versionLabel: '费用申请 v1', submittedAt: '2026-08-20T10:00:00Z', data: { name: '培训预算', department: '财务', amount: '12000' }, ruleSnapshot: [], validationResults: [], interceptReasons: [], status: 'accepted', legacy: true, classificationStatus: 'pending' },
    { id: 's2', versionId: 'v1', versionLabel: '费用申请 v1', submittedAt: '2026-08-22T14:30:00Z', data: { name: '市场活动费用', department: '市场', amount: '58000' }, ruleSnapshot: [], validationResults: [], interceptReasons: [], status: 'accepted', legacy: true, classificationStatus: 'pending' },
    // 运行态提交：冻结当时规则与校验结果
    { id: 'sub1', versionId: 'v2', versionLabel: '费用申请 v2', submittedAt: '2026-09-29T09:15:00Z', data: sub1Data, ruleSnapshot: structuredClone(v2rules), validationResults: sub1Validation.results, interceptReasons: sub1Validation.reasons, status: sub1Validation.status },
    { id: 'sub2', versionId: 'v2', versionLabel: '费用申请 v2', submittedAt: '2026-09-29T11:00:00Z', data: sub2Data, ruleSnapshot: structuredClone(v2rules), validationResults: sub2Validation.results, interceptReasons: sub2Validation.reasons, status: sub2Validation.status }
  ],
  impactPreviews: [],
  faultInjection: false
};

function getDraft(state: SchemaState): FormVersion | undefined {
  return state.versions.find((v) => v.id === state.previewVersionId && v.status === 'draft');
}

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const draft = getDraft(state);
      if (!draft) return;
      const from = draft.fields.findIndex((f) => f.id === action.payload.activeId);
      const to = draft.fields.findIndex((f) => f.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = draft.fields.splice(from, 1);
      draft.fields.splice(to, 0, moved);
    },
    addField(state) {
      const draft = getDraft(state);
      if (!draft) return;
      draft.fields.push({ id: `field-${nanoid(6)}`, label: '新字段', type: 'text', required: false });
    },
    offlineField(state, action: PayloadAction<string>) {
      const draft = getDraft(state);
      if (!draft) return;
      const field = draft.fields.find((f) => f.id === action.payload);
      if (field) field.offline = !field.offline;
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const draft = getDraft(state);
      if (!draft) return;
      draft.rules.push({ ...action.payload, id: `rule-${nanoid(6)}` });
    },
    updateRule(state, action: PayloadAction<LinkRule>) {
      const draft = getDraft(state);
      if (!draft) return;
      const idx = draft.rules.findIndex((r) => r.id === action.payload.id);
      if (idx >= 0) draft.rules[idx] = action.payload;
    },
    removeRule(state, action: PayloadAction<string>) {
      const draft = getDraft(state);
      if (!draft) return;
      draft.rules = draft.rules.filter((r) => r.id !== action.payload);
    },
    setFaultInjection(state, action: PayloadAction<boolean>) { state.faultInjection = action.payload; },
    // 模拟另一标签页已发布：抬高最新基线，制造冲突
    simulateOtherTabPublish(state) {
      const latest = state.versions.find((v) => v.id === state.activeVersionId);
      if (!latest) return;
      const n = state.versions.length;
      const id = `v${n + 1}`;
      state.versions.push({ ...structuredClone(latest), id, label: `费用申请 ${id}`, status: 'published', baselineVersionId: latest.id, publishedAt: new Date().toISOString() });
      state.activeVersionId = id;
    },
    previewImpact(state) {
      const draft = getDraft(state);
      if (!draft) return;
      const baseline = state.versions.find((v) => v.id === draft.baselineVersionId);
      const items = computeImpact(draft, baseline, state.submissions);
      const cycle = detectCycle(draft.rules);
      state.impactPreviews.push({
        id: `ip-${nanoid(6)}`, draftVersionId: draft.id, baselineVersionId: draft.baselineVersionId ?? '',
        createdAt: new Date().toISOString(), items, status: cycle.length ? 'blocked' : 'preview', processedSubmissionIds: []
      });
    },
    // 重新基线：草稿对齐最新已发布版本，并重算当前预演的影响清单
    rebaseDraft(state) {
      const draft = getDraft(state);
      if (!draft) return;
      draft.baselineVersionId = state.activeVersionId;
      const preview = state.impactPreviews[state.impactPreviews.length - 1];
      if (preview && preview.draftVersionId === draft.id) {
        const baseline = state.versions.find((v) => v.id === draft.baselineVersionId);
        preview.items = computeImpact(draft, baseline, state.submissions);
        preview.baselineVersionId = draft.baselineVersionId ?? '';
        preview.status = detectCycle(draft.rules).length ? 'blocked' : 'preview';
        preview.processedSubmissionIds = [];
      }
    },
    confirmPublish(state) {
      const preview = state.impactPreviews[state.impactPreviews.length - 1];
      if (!preview || (preview.status !== 'preview' && preview.status !== 'conflict')) return;
      const draft = getDraft(state);
      if (!draft || draft.id !== preview.draftVersionId) return;
      if (draft.baselineVersionId !== state.activeVersionId) { preview.status = 'conflict'; return; }
      if (detectCycle(draft.rules).length) { preview.status = 'blocked'; return; }
      const n = state.versions.length;
      const frozenId = `v${n + 1}`;
      const frozen: FormVersion = {
        id: frozenId, label: `费用申请 ${frozenId}`, createdAt: new Date().toISOString().slice(0, 10),
        status: 'published', fields: structuredClone(draft.fields), rules: structuredClone(draft.rules),
        baselineVersionId: draft.baselineVersionId, publishedAt: new Date().toISOString()
      };
      state.versions.push(frozen);
      state.activeVersionId = frozenId;
      preview.frozenVersionId = frozenId;
      // 草稿内容即冻结内容，基线同步到冻结版（草稿保留，不覆盖已发布版）
      draft.baselineVersionId = frozenId;
      preview.status = 'writing';
      const itemIds = preview.items.map((i) => i.submissionId);
      if (state.faultInjection && !preview.faultConsumed) {
        const half = Math.ceil(itemIds.length / 2);
        preview.processedSubmissionIds = itemIds.slice(0, half);
        preview.status = 'partial';
        preview.faultConsumed = true;
      } else {
        preview.processedSubmissionIds = itemIds;
        preview.status = 'published';
      }
    },
    retryPublish(state, action: PayloadAction<string>) {
      const preview = state.impactPreviews.find((p) => p.id === action.payload);
      if (!preview) return;
      const draft = getDraft(state);
      if (!draft || draft.id !== preview.draftVersionId) return;
      if (preview.status === 'conflict') {
        if (draft.baselineVersionId !== state.activeVersionId) return;
      }
      if (!preview.frozenVersionId) {
        if (draft.baselineVersionId !== state.activeVersionId) { preview.status = 'conflict'; return; }
        if (detectCycle(draft.rules).length) { preview.status = 'blocked'; return; }
        const n = state.versions.length;
        const frozenId = `v${n + 1}`;
        state.versions.push({
          id: frozenId, label: `费用申请 ${frozenId}`, createdAt: new Date().toISOString().slice(0, 10),
          status: 'published', fields: structuredClone(draft.fields), rules: structuredClone(draft.rules),
          baselineVersionId: draft.baselineVersionId, publishedAt: new Date().toISOString()
        });
        state.activeVersionId = frozenId;
        preview.frozenVersionId = frozenId;
        draft.baselineVersionId = frozenId;
      }
      const itemIds = preview.items.map((i) => i.submissionId);
      const remaining = itemIds.filter((id) => !preview.processedSubmissionIds.includes(id));
      if (state.faultInjection && !preview.faultConsumed) {
        const half = Math.ceil(remaining.length / 2);
        preview.processedSubmissionIds.push(...remaining.slice(0, half));
        preview.status = 'partial';
        preview.faultConsumed = true;
      } else {
        preview.processedSubmissionIds.push(...remaining);
        preview.status = 'published';
      }
    },
    submitRuntime(state, action: PayloadAction<{ versionId: string; data: Record<string, unknown> }>) {
      const version = state.versions.find((v) => v.id === action.payload.versionId && v.status === 'published');
      if (!version) return;
      const { status, reasons, results } = validateVersion(version, action.payload.data);
      state.submissions.push({
        id: `sub-${nanoid(6)}`, versionId: version.id, versionLabel: version.label,
        submittedAt: new Date().toISOString(), data: action.payload.data,
        ruleSnapshot: structuredClone(version.rules), validationResults: results,
        interceptReasons: reasons, status
      });
    },
    classifyLegacy(state, action: PayloadAction<{ submissionId: string; note: string }>) {
      const sub = state.submissions.find((s) => s.id === action.payload.submissionId);
      if (!sub || !sub.legacy) return;
      sub.classificationStatus = 'classified';
      sub.classificationNote = action.payload.note;
    },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const {
  addField, addRule, classifyLegacy, confirmPublish, offlineField, previewImpact,
  rebaseDraft, removeRule, reorderFields, retryPublish, selectPreview, setFaultInjection,
  simulateOtherTabPublish, submitRuntime, updateRule, replaceState
} = slice.actions;

export const store = configureStore({ reducer: { schema: slice.reducer } });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;
