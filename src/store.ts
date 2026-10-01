import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  buildImpactPlan,
  cloneJson,
  evaluate,
  getTabId,
  LS_BASELINE,
  LS_LEGACY,
  makeDraft,
  makeFrozenSnapshot,
  nowText,
  readDraft,
  readJobState,
  today,
  writeDraft,
  writeJobState,
  type BaselineDoc,
  type CalcRule,
  type Classification,
  type FormField,
  type FormVersion,
  type ImpactKind,
  type ImpactPlan,
  type LinkRule,
  type PublishJob,
  type Submission,
  type WriteItem,
} from './versioning';

// ---------- 初始基线账 ----------

const v1: FormVersion = {
  id: 'v1',
  label: '费用申请 v1',
  createdAt: '2026-08-12',
  status: 'frozen',
  basedOnRevision: 0,
  revision: 1,
  fields: [
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'amount', label: '申请金额', type: 'number', required: true },
  ],
  linkRules: [],
  calcRules: [],
};

const seedSubmissions: Submission[] = [
  {
    id: 's1',
    label: '八月培训预算',
    createdAt: '2026-08-15 10:02',
    data: { name: '培训预算', department: '财务', amount: '12000' },
    versionId: 'v1',
    // 历史数据：有结构版本但没有规则版本 → 待归类，兼容读取
    rulesVersion: '',
    status: 'pending_classify',
    stamps: [],
  },
  {
    id: 's2',
    label: '市场活动费用',
    createdAt: '2026-08-20 14:30',
    data: { name: '新品活动', department: '市场', amount: '58000' },
    versionId: 'v1',
    rulesVersion: '',
    status: 'pending_classify',
    stamps: [],
  },
];

function freshBaseline(): BaselineDoc {
  return { revision: 1, seq: 1, activeVersionId: 'v1', frozenVersions: [v1], submissions: seedSubmissions };
}

// 旧账（yf55-schema-state）一次性迁入：结构转冻结版本、快照转待归类申请
function migrateLegacy(raw: string): BaselineDoc {
  const doc = freshBaseline();
  try {
    const old = JSON.parse(raw) as {
      versions?: FormVersion[];
      snapshots?: { id: string; versionId: string; label: string; createdAt?: string; data: Record<string, string> }[];
    };
    const oldVersions = (old.versions ?? []) as Array<
      FormVersion & { rules?: LinkRule[] }
    >;
    const versions = oldVersions.map((v, i) => ({
      ...v,
      status: 'frozen' as const,
      linkRules: v.linkRules ?? v.rules ?? [],
      calcRules: v.calcRules ?? [],
      basedOnRevision: 0,
      revision: i + 1,
    }));
    if (versions.length) {
      doc.frozenVersions = versions;
      doc.revision = versions.length;
      doc.seq = versions.length;
      doc.activeVersionId = versions[versions.length - 1].id;
    }
    doc.submissions = (old.snapshots ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      createdAt: s.createdAt ?? '',
      data: s.data,
      versionId: s.versionId,
      rulesVersion: '',
      status: 'pending_classify' as const,
      stamps: [],
    }));
  } catch {
    /* 坏账直接丢弃，走初始账 */
  }
  return doc;
}

export function loadBaseline(): BaselineDoc {
  if (typeof localStorage === 'undefined') return freshBaseline();
  const raw = localStorage.getItem(LS_BASELINE);
  if (raw) {
    try {
      return JSON.parse(raw) as BaselineDoc;
    } catch {
      /* fallthrough */
    }
  }
  const legacy = localStorage.getItem(LS_LEGACY);
  const doc = legacy ? migrateLegacy(legacy) : freshBaseline();
  localStorage.setItem(LS_BASELINE, JSON.stringify(doc));
  return doc;
}

function saveBaseline(doc: BaselineDoc) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(LS_BASELINE, JSON.stringify(doc));
}

// ---------- Redux 状态 ----------

interface SchemaState {
  tabId: string;
  baseline: BaselineDoc;
  draft: FormVersion | null;
  plan: ImpactPlan | null;
  job: PublishJob | null;
  conflictRevision: number | null; // 跨标签页发布后的最新基线 revision
}

type RootShape = { schema: SchemaState };

function initialState(): SchemaState {
  const baseline = loadBaseline();
  return { tabId: getTabId(), baseline, draft: readDraft(), plan: null, job: readJobState(), conflictRevision: null };
}

// ---------- 发布任务执行（可重试，幂等） ----------

function buildWriteItems(doc: BaselineDoc, plan: ImpactPlan, frozen: FormVersion): WriteItem[] {
  const items: WriteItem[] = [
    { id: 'freeze', kind: 'freeze_version', label: `生成冻结发布版 ${frozen.label}`, status: 'pending' },
  ];
  for (const sid of plan.affectedIds) {
    const s = doc.submissions.find((x) => x.id === sid);
    if (s) items.push({ id: `stamp-${sid}`, kind: 'stamp_submission', label: `登记影响：${s.label}`, refId: sid, status: 'pending' });
  }
  return items;
}

function kindsOn(sid: string, plan: ImpactPlan): ImpactKind[] {
  return plan.groups.filter((g) => g.affectedIds.includes(sid)).map((g) => g.kind);
}

// 写一项；成功后该项 done，异常该项 failed 且整单保留
function applyWriteItem(doc: BaselineDoc, job: PublishJob, item: WriteItem): void {
  const frozen = doc.frozenVersions.find((v) => v.id === job.newVersionId);
  if (item.kind === 'freeze_version') {
    if (frozen) {
      item.status = 'done'; // 冻结写入由 driveJob 在调用前完成，这里幂等标记
      return;
    }
    item.status = 'pending';
    return;
  }
  if (!frozen) {
    item.status = 'pending';
    return;
  }
  const s = doc.submissions.find((x) => x.id === item.refId);
  if (!s) {
    item.status = 'done';
    return;
  }
  if (!s.stamps.some((t) => t.jobId === job.id)) {
    s.stamps.push({
      at: nowText(),
      jobId: job.id,
      fromVersionId: job.plan.baselineId,
      toVersionId: job.newVersionId,
      kinds: kindsOn(s.id, job.plan),
      detail: `新版本「${job.newVersionLabel}」对该存量申请的影响预演登记`,
    });
  }
  item.status = 'done';
}

const slice = createSlice({
  name: 'schema',
  initialState: initialState,
  reducers: {
    // ---- 草稿编排（只改草稿，不碰已发布版本） ----
    ensureDraft(state) {
      if (state.draft) return;
      const base = state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId) ??
        state.baseline.frozenVersions[0];
      state.draft = makeDraft(base, state.baseline.revision);
      writeDraft(state.draft);
    },
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      if (!state.draft) return;
      const from = state.draft.fields.findIndex((f) => f.id === action.payload.activeId);
      const to = state.draft.fields.findIndex((f) => f.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = state.draft.fields.splice(from, 1);
      state.draft.fields.splice(to, 0, moved);
      writeDraft(state.draft);
    },
    addField(state) {
      if (!state.draft) return;
      state.draft.fields.push({ id: `field-${Date.now()}`, label: '新字段', type: 'text', required: false });
      writeDraft(state.draft);
    },
    updateField(state, action: PayloadAction<{ id: string; patch: Partial<FormField> }>) {
      if (!state.draft) return;
      const f = state.draft.fields.find((x) => x.id === action.payload.id);
      if (f) Object.assign(f, action.payload.patch);
      writeDraft(state.draft);
    },
    offlineField(state, action: PayloadAction<{ id: string }>) {
      if (!state.draft) return;
      state.draft.fields = state.draft.fields.filter((f) => f.id !== action.payload.id);
      state.draft.linkRules = state.draft.linkRules.filter(
        (r) => r.fieldId !== action.payload.id && r.targetId !== action.payload.id
      );
      state.draft.calcRules = state.draft.calcRules.filter(
        (r) => r.targetId !== action.payload.id && !r.sourceIds.includes(action.payload.id)
      );
      writeDraft(state.draft);
    },
    addLinkRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      if (!state.draft) return;
      state.draft.linkRules.push({ ...action.payload, id: `rule-${Date.now()}` });
      writeDraft(state.draft);
    },
    updateLinkRule(state, action: PayloadAction<{ id: string; patch: Partial<LinkRule> }>) {
      if (!state.draft) return;
      const r = state.draft.linkRules.find((x) => x.id === action.payload.id);
      if (r) Object.assign(r, action.payload.patch);
      writeDraft(state.draft);
    },
    deleteLinkRule(state, action: PayloadAction<{ id: string }>) {
      if (!state.draft) return;
      state.draft.linkRules = state.draft.linkRules.filter((r) => r.id !== action.payload.id);
      writeDraft(state.draft);
    },
    upsertCalcRule(state, action: PayloadAction<CalcRule>) {
      if (!state.draft) return;
      const idx = state.draft.calcRules.findIndex((r) => r.id === action.payload.id);
      if (idx >= 0) state.draft.calcRules[idx] = action.payload;
      else state.draft.calcRules.push(action.payload);
      writeDraft(state.draft);
    },
    deleteCalcRule(state, action: PayloadAction<{ id: string }>) {
      if (!state.draft) return;
      state.draft.calcRules = state.draft.calcRules.filter((r) => r.id !== action.payload.id);
      writeDraft(state.draft);
    },
    discardDraft(state) {
      state.draft = null;
      state.plan = null;
      writeDraft(null);
    },

    // ---- 影响预演（草稿 → 当前最新基线） ----
    runImpactPreview(state) {
      if (!state.draft) return;
      const baseline =
        state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId) ??
        state.baseline.frozenVersions[state.baseline.frozenVersions.length - 1];
      state.plan = buildImpactPlan(state.draft, baseline, state.baseline.revision, state.baseline.submissions);
    },
    clearPlan(state) {
      state.plan = null;
    },

    // ---- 确认发布：按最新基线检测冲突；冲突则草稿保留、不覆盖 ----
    confirmPublish(state, action: PayloadAction<{ simulateFailure?: boolean } | undefined>) {
      if (!state.draft || !state.plan || state.plan.hasBlocking) return;
      if (state.plan.baselineRevision !== state.baseline.revision) {
        // 另一标签页已发布：按最新基线重做预演，草稿保留
        state.conflictRevision = state.baseline.revision;
        const baseline =
          state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId) ??
          state.baseline.frozenVersions[state.baseline.frozenVersions.length - 1];
        state.plan = buildImpactPlan(state.draft, baseline, state.baseline.revision, state.baseline.submissions);
        return;
      }
      const seq = state.baseline.seq + 1;
      const id = `v${seq}`;
      const frozen: FormVersion = {
        ...cloneJson(state.draft),
        id,
        label: `费用申请 ${id}`,
        createdAt: today(),
        status: 'frozen',
        basedOnRevision: state.baseline.revision,
        revision: state.baseline.revision + 1,
      };
      sessionStorage.setItem('yf55-payload', JSON.stringify(frozen));
      const job: PublishJob = {
        id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        newVersionId: id,
        newVersionLabel: frozen.label,
        draftId: state.draft.id,
        draftLabel: state.draft.label,
        baseRevision: state.baseline.revision,
        plan: state.plan,
        items: buildWriteItems(state.baseline, state.plan, frozen),
        status: 'writing',
        startedAt: nowText(),
        simulateFailure: action.payload?.simulateFailure === true,
      };
      state.job = job;
      writeJobState(job);
    },

    // 驱动写入：冻结先落账并推进 revision；影响登记逐项写入、可重试
    driveJob(state) {
      const job = state.job;
      if (!job || job.status === 'done' || job.status === 'conflict') return;
      // 发布前最后一次基线检测：允许任务分叉点 revision，或本任务冻结已落账的 revision；
      // 其他标签页若抢先发布（revision 跳过本任务）则判冲突
      const freezeDone = job.items.find((i) => i.kind === 'freeze_version')?.status === 'done';
      const expectedRevision = freezeDone ? job.baseRevision + 1 : job.baseRevision;
      if (state.baseline.revision !== expectedRevision) {
        job.status = 'conflict';
        job.conflictActualRevision = state.baseline.revision;
        state.conflictRevision = state.baseline.revision;
        writeJobState(job);
        return;
      }
      // 1) 冻结发布版先落账（原子），立即推进 revision 并持久化，让其他标签页看到新基线
      const freeze = job.items.find((i) => i.kind === 'freeze_version');
      if (freeze && freeze.status === 'pending') {
        const payloadRaw = sessionStorage.getItem('yf55-payload');
        if (!payloadRaw) {
          freeze.status = 'failed';
          freeze.error = '冻结载荷丢失（草稿仍保留，可重新预演发布）';
          job.status = 'failed';
          writeJobState(job);
          return;
        }
        state.baseline.frozenVersions.push(JSON.parse(payloadRaw) as FormVersion);
        state.baseline.activeVersionId = job.newVersionId;
        state.baseline.seq = Math.max(state.baseline.seq, Number(job.newVersionId.slice(1)) || state.baseline.seq);
        state.baseline.revision = job.baseRevision + 1;
        freeze.status = 'done';
        saveBaseline(state.baseline);
        writeJobState(job);
      }
      // 2) 影响清单逐项写入；模拟故障：冻结成功后让第一项影响登记失败
      if (job.simulateFailure) {
        const target = job.items.find((i) => i.status === 'pending');
        if (target) {
          target.status = 'failed';
          target.error = '模拟写入失败（存储暂时不可用）';
          job.status = 'failed';
          job.simulateFailure = false; // 仅触发一次，后续重试不再注入故障
          writeJobState(job);
          return;
        }
      }
      for (const item of job.items) {
        if (item.status !== 'pending') continue;
        try {
          applyWriteItem(state.baseline, job, item);
          saveBaseline(state.baseline); // 每项成功即落盘，清单进度不丢
        } catch (e) {
          item.status = 'failed';
          item.error = e instanceof Error ? e.message : String(e);
          job.status = 'failed';
          writeJobState(job);
          saveBaseline(state.baseline);
          return;
        }
      }
      if (job.items.some((i) => i.status === 'failed')) {
        job.status = 'failed';
      } else if (job.items.every((i) => i.status === 'done')) {
        job.status = 'done';
        state.plan = null;
        state.draft = null; // 发布完成后清理草稿（冻结版已落账）
        writeDraft(null);
        sessionStorage.removeItem('yf55-payload');
      }
      writeJobState(job);
      saveBaseline(state.baseline);
    },

    // 重试：只重置/处理 failed、pending 项，已完成项不动
    retryJob(state) {
      const job = state.job;
      if (!job || job.status !== 'failed') return;
      job.status = 'writing';
      for (const item of job.items) if (item.status === 'failed') item.status = 'pending';
      writeJobState(job);
    },

    // 冲突后：按最新基线重新预演，仍可再次确认；草稿不动
    rebasePlan(state) {
      if (!state.draft || !state.job) return;
      const baseline =
        state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId) ??
        state.baseline.frozenVersions[state.baseline.frozenVersions.length - 1];
      state.plan = buildImpactPlan(state.draft, baseline, state.baseline.revision, state.baseline.submissions);
      state.job = null;
      state.conflictRevision = null;
      writeJobState(null);
      sessionStorage.removeItem('yf55-payload');
    },
    dismissJob(state) {
      state.job = null;
      writeJobState(null);
      sessionStorage.removeItem('yf55-payload');
    },

    // ---- 运行态提交：保存当时规则快照与校验结果（含拦截单） ----
    submitRuntime(state, action: PayloadAction<{ id: string; label: string; data: Record<string, string> }>) {
      const v =
        state.baseline.frozenVersions.find((x) => x.id === state.baseline.activeVersionId) ??
        state.baseline.frozenVersions[state.baseline.frozenVersions.length - 1];
      const { status, evaluations } = evaluate(v, action.payload.data);
      const submission: Submission = {
        id: action.payload.id,
        label: action.payload.label || `申请 ${state.baseline.submissions.length + 1}`,
        createdAt: nowText(),
        data: { ...action.payload.data },
        versionId: v.id,
        rulesVersion: `${v.id}@r${v.revision ?? state.baseline.revision}`,
        frozenRules: makeFrozenSnapshot(v),
        validation: { status, evaluatedAt: nowText(), evaluations },
        status,
        stamps: [],
      };
      state.baseline.submissions.push(submission);
      saveBaseline(state.baseline);
    },

    // ---- 待归类：补解释，但不重算原结果 ----
    classifySubmission(state, action: PayloadAction<{ id: string; note: string; mappedVersionId: string }>) {
      const s = state.baseline.submissions.find((x) => x.id === action.payload.id);
      if (!s || s.status !== 'pending_classify') return;
      const classification: Classification = { at: nowText(), note: action.payload.note, mappedVersionId: action.payload.mappedVersionId };
      s.classification = classification;
      s.status = 'classified';
      // 只补解释：写入兼容读取结果的说明，绝不生成 validation、不改 data
      saveBaseline(state.baseline);
    },

    // ---- 跨标签页：基线变更事件 ----
    baselineChanged(state, action: PayloadAction<BaselineDoc>) {
      const next = action.payload;
      if (next.revision === state.baseline.revision) return;
      const wasBehind = next.revision > state.baseline.revision;
      state.baseline = next;
      if (wasBehind) state.conflictRevision = next.revision;
    },
    clearConflict(state) {
      state.conflictRevision = null;
    },

    replaceState(_state, action: PayloadAction<SchemaState>) {
      return action.payload;
    },
  },
});

export const {
  addField,
  addLinkRule,
  baselineChanged,
  classifySubmission,
  clearConflict,
  confirmPublish,
  deleteCalcRule,
  deleteLinkRule,
  discardDraft,
  dismissJob,
  driveJob,
  ensureDraft,
  offlineField,
  rebasePlan,
  reorderFields,
  retryJob,
  runImpactPreview,
  submitRuntime,
  updateField,
  updateLinkRule,
  upsertCalcRule,
} = slice.actions;

export const store = configureStore({ reducer: { schema: slice.reducer } });

// 跨标签页：另一标签页写入基线后，本标签页按最新基线检测发布冲突
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === LS_BASELINE && event.newValue) {
      try {
        const doc = JSON.parse(event.newValue) as BaselineDoc;
        store.dispatch(baselineChanged(doc));
      } catch {
        /* ignore */
      }
    }
  });
}

export type RootState = RootShape;
