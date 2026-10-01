import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField,
  addLinkRule,
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
} from './store';
import {
  compatRead,
  describeCalcRule,
  describeLinkRule,
  evalFormula,
  fieldLabelOf,
  findCalcCycles,
  impactKindLabel,
  parseSources,
  type CalcRule,
  type FormField,
  type FormVersion,
  type ImpactGroup,
  type LinkRule,
  type RuleEvaluation,
  type Submission,
} from './versioning';
import type { RootState } from './store';

// ============ 草稿编排 ============

function SortableField({
  field,
  onToggleRequired,
  onRename,
  onOffline,
}: {
  field: FormField;
  onToggleRequired: (required: boolean) => void;
  onRename: (label: string) => void;
  onOffline: () => void;
}) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card
      ref={sortable.setNodeRef}
      variant="outlined"
      sx={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    >
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: '10px !important' }}>
        <Box {...sortable.attributes} {...sortable.listeners} sx={{ cursor: 'grab', px: 1, color: 'text.secondary' }}>
          ⠿
        </Box>
        <TextField
          size="small"
          value={field.label}
          onChange={(e) => onRename(e.target.value)}
          sx={{ width: 180 }}
        />
        <Chip size="small" label={field.type} variant="outlined" />
        <FormControlLabel
          control={<Checkbox size="small" checked={field.required} onChange={(e) => onToggleRequired(e.target.checked)} />}
          label="必填"
        />
        <Box flexGrow={1} />
        <Tooltip title="字段下线（预演会列出受影响存量申请）">
          <IconButton size="small" color="warning" onClick={onOffline}>
            <DeleteOutlineIcon />
          </IconButton>
        </Tooltip>
      </CardContent>
    </Card>
  );
}

function LinkRuleEditor({ draft }: { draft: FormVersion }) {
  const dispatch = useDispatch();
  const [ruleId, setRuleId] = useState('');
  const r = draft.linkRules.find((x) => x.id === ruleId) ?? draft.linkRules[0];

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="subtitle1">联动规则（改向 = 触发字段/算符/取值/效果/目标变化）</Typography>
        <Button
          size="small"
          disabled={draft.fields.length < 2}
          onClick={() =>
            dispatch(
              addLinkRule({
                fieldId: draft.fields[0]?.id ?? '',
                operator: 'equals',
                value: '',
                effect: 'require',
                targetId: draft.fields[1]?.id ?? draft.fields[0]?.id ?? '',
              })
            )
          }
        >
          添加规则
        </Button>
      </Stack>
      {draft.linkRules.length === 0 && <Typography variant="body2" color="text.secondary">暂无联动规则</Typography>}
      {draft.linkRules.map((rule) => (
        <Card
          key={rule.id}
          variant="outlined"
          sx={{ mb: 1, outline: rule.id === r?.id ? '2px solid #1976d2' : 'none' }}
          onMouseEnter={() => setRuleId(rule.id)}
        >
          <CardContent sx={{ py: '10px !important' }}>
            <Typography variant="body2" mb={1}>{describeLinkRule(rule, draft)}</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel>触发字段</InputLabel>
                <Select
                  label="触发字段"
                  value={rule.fieldId}
                  onChange={(e) => dispatch(updateLinkRule({ id: rule.id, patch: { fieldId: e.target.value } }))}
                >
                  {draft.fields.map((f) => (
                    <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 100 }}>
                <InputLabel>算符</InputLabel>
                <Select
                  label="算符"
                  value={rule.operator}
                  onChange={(e) =>
                    dispatch(updateLinkRule({ id: rule.id, patch: { operator: e.target.value as LinkRule['operator'] } }))
                  }
                >
                  <MenuItem value="equals">等于</MenuItem>
                  <MenuItem value="notEmpty">非空</MenuItem>
                </Select>
              </FormControl>
              {rule.operator === 'equals' && (
                <TextField
                  size="small"
                  label="取值"
                  value={rule.value}
                  sx={{ width: 110 }}
                  onChange={(e) => dispatch(updateLinkRule({ id: rule.id, patch: { value: e.target.value } }))}
                />
              )}
              <FormControl size="small" sx={{ minWidth: 100 }}>
                <InputLabel>效果</InputLabel>
                <Select
                  label="效果"
                  value={rule.effect}
                  onChange={(e) =>
                    dispatch(updateLinkRule({ id: rule.id, patch: { effect: e.target.value as LinkRule['effect'] } }))
                  }
                >
                  <MenuItem value="require">要求填写</MenuItem>
                  <MenuItem value="show">显示</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel>目标字段</InputLabel>
                <Select
                  label="目标字段"
                  value={rule.targetId}
                  onChange={(e) => dispatch(updateLinkRule({ id: rule.id, patch: { targetId: e.target.value } }))}
                >
                  {draft.fields.map((f) => (
                    <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <IconButton color="error" onClick={() => dispatch(deleteLinkRule({ id: rule.id }))}>
                <DeleteOutlineIcon />
              </IconButton>
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Box>
  );
}

function CalcRuleEditor({ draft }: { draft: FormVersion }) {
  const dispatch = useDispatch();
  const [targetId, setTargetId] = useState(draft.fields[0]?.id ?? '');
  const [formula, setFormula] = useState('amount * 0.1');
  const cycles = findCalcCycles(draft);
  const cycleTargets = useMemo(() => new Set(cycles.flat()), [cycles]);

  function add() {
    const id = `calc-${Date.now()}`;
    const rule: CalcRule = { id, targetId: targetId || draft.fields[0]?.id || '', formula, sourceIds: parseSources(formula, draft) };
    dispatch(upsertCalcRule(rule));
  }

  return (
    <Box mt={2}>
      <Typography variant="subtitle1" mb={1}>计算规则（公式仅支持 字段id、+ - * /、括号；依赖成环会阻断发布）</Typography>
      {cycles.length > 0 && (
        <Alert severity="error" sx={{ mb: 1 }}>
          检测到计算依赖成环：{cycles.map((c) => c.map((id) => fieldLabelOf(draft, id)).join(' → ')).join('；')}
        </Alert>
      )}
      {draft.calcRules.map((rule) => (
        <Alert
          key={rule.id}
          severity={cycleTargets.has(rule.targetId) ? 'error' : 'info'}
          sx={{ mb: 1 }}
          action={
            <IconButton color="inherit" size="small" onClick={() => dispatch(deleteCalcRule({ id: rule.id }))}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          }
        >
          {describeCalcRule(rule, draft)}
          <Typography variant="caption" display="block" color="text.secondary">
            依赖字段：{rule.sourceIds.map((id) => fieldLabelOf(draft, id)).join('、') || '无'}
          </Typography>
        </Alert>
      ))}
      <Stack direction="row" spacing={1} mt={1}>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>结果写入字段</InputLabel>
          <Select label="结果写入字段" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {draft.fields.map((f) => (
              <MenuItem key={f.id} value={f.id}>{f.label}（{f.id}）</MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          size="small"
          label="公式（用字段 id）"
          value={formula}
          sx={{ flexGrow: 1 }}
          onChange={(e) => setFormula(e.target.value)}
          helperText={`依赖：${parseSources(formula, draft).join('、') || '无'}`}
        />
        <Button variant="outlined" disabled={!targetId} onClick={add}>添加计算</Button>
      </Stack>
    </Box>
  );
}

function DraftPanel() {
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.schema);
  const sensors = useSensors(useSensor(PointerSensor));
  useEffect(() => {
    if (!state.draft) dispatch(ensureDraft());
  }, [dispatch, state.draft]);
  if (!state.draft) return null;
  const draft = state.draft;

  function dragEnd(e: DragEndEvent) {
    if (e.over && e.active.id !== e.over.id) {
      dispatch(reorderFields({ activeId: String(e.active.id), overId: String(e.over.id) }));
    }
  }

  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
          <div>
            <Typography variant="h6">草稿编排</Typography>
            <Typography variant="body2" color="text.secondary">
              {draft.label} · 分叉自基线 revision {draft.basedOnRevision}（仅本标签页可见，不影响已发布版本）
            </Typography>
          </div>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" color="warning" onClick={() => dispatch(discardDraft())}>放弃草稿</Button>
            <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>
          </Stack>
        </Stack>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext items={draft.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <Stack spacing={1}>
              {draft.fields.map((field) => (
                <SortableField
                  key={field.id}
                  field={field}
                  onRename={(label) => dispatch(updateField({ id: field.id, patch: { label } }))}
                  onToggleRequired={(required) => dispatch(updateField({ id: field.id, patch: { required } }))}
                  onOffline={() => dispatch(offlineField({ id: field.id }))}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
        <Divider sx={{ my: 3 }} />
        <LinkRuleEditor draft={draft} />
        <Divider sx={{ my: 2 }} />
        <CalcRuleEditor draft={draft} />
      </CardContent>
    </Card>
  );
}

// ============ 影响预演与发布 ============

const GROUP_SEVERITY: Record<ImpactGroup['kind'], 'error' | 'warning' | 'info'> = {
  field_offline: 'warning',
  rule_redirect: 'warning',
  calc_cycle: 'error',
  new_required: 'info',
};

function ImpactPreview() {
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.schema);
  const { draft, plan, baseline, job, conflictRevision } = state;
  const active = baseline.frozenVersions.find((v) => v.id === baseline.activeVersionId);

  const stale = plan ? plan.baselineRevision !== baseline.revision : false;

  return (
    <Box mt={2}>
      <Stack direction="row" spacing={1} alignItems="center" mb={2}>
        <Button variant="contained" disabled={!draft} onClick={() => dispatch(runImpactPreview())}>
          对最新基线做影响预演
        </Button>
        <Typography variant="body2" color="text.secondary">
          已发布基线：{active?.label}（revision {baseline.revision}）
        </Typography>
      </Stack>

      {conflictRevision !== null && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => dispatch(clearConflict())}>知道了</Button>
          }
        >
          检测到其他标签页已发布（基线已推进到 revision {conflictRevision}）。后提交的发布将按最新基线重新检测冲突，草稿保留、不会覆盖已发布版本。
        </Alert>
      )}

      {!plan && <Alert severity="info">点击「影响预演」：字段下线、规则改向、计算依赖成环时会列出受影响的存量申请，确认后才生成冻结发布版。</Alert>}

      {plan && (
        <>
          {stale && (
            <Alert severity="warning" sx={{ mb: 2 }} action={
              <Button color="inherit" size="small" onClick={() => dispatch(runImpactPreview())}>按最新基线重算</Button>
            }>
              该预演基于 revision {plan.baselineRevision}，当前基线已是 revision {baseline.revision}，存在并发冲突，请重算后再发布。
            </Alert>
          )}
          <Typography variant="subtitle1" mb={1}>
            预演结果：{plan.groups.length === 0 ? '无结构性变更' : ''} 受影响存量申请 {plan.affectedCount} 单
          </Typography>
          {plan.groups.map((g) => (
            <Alert key={g.kind} severity={GROUP_SEVERITY[g.kind]} sx={{ mb: 1 }}>
              <Typography fontWeight={700}>
                {g.title}
                {g.blocking && <Chip size="small" color="error" label="阻断发布" sx={{ ml: 1 }} />}
              </Typography>
              {g.items.map((item) => (
                <Typography key={item.key} variant="body2">· {item.title}</Typography>
              ))}
              {g.affectedIds.length > 0 && (
                <Typography variant="body2" mt={0.5}>
                  受影响存量申请（{g.affectedIds.length}）：
                  {g.affectedIds
                    .map((id) => baseline.submissions.find((s) => s.id === id)?.label ?? id)
                    .join('、')}
                </Typography>
              )}
            </Alert>
          ))}
          {plan.groups.length === 0 && <Alert severity="success">草稿与基线一致，无字段下线 / 规则改向 / 成环 / 新增必填。</Alert>}

          {!job && (
            <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
              <Button
                variant="contained"
                color={plan.hasBlocking ? 'error' : 'primary'}
                disabled={plan.hasBlocking || stale}
                onClick={() => {
                  dispatch(confirmPublish({ simulateFailure: false }));
                  dispatch(driveJob());
                }}
              >
                {plan.hasBlocking ? '存在成环，禁止发布' : `确认发布（冻结 v${baseline.seq + 1}）`}
              </Button>
              <Tooltip title="冻结发布版正常落账，随后第一项影响登记模拟失败：清单保留，可只重试未完成项">
                <Button
                  variant="outlined"
                  color="error"
                  disabled={plan.hasBlocking || stale || plan.affectedCount === 0}
                  onClick={() => {
                    dispatch(confirmPublish({ simulateFailure: true }));
                    dispatch(driveJob());
                  }}
                >
                  演示：确认发布但影响登记失败
                </Button>
              </Tooltip>
              <Button variant="text" onClick={() => dispatch(runImpactPreview())}>重新预演</Button>
            </Stack>
          )}
        </>
      )}

      {job && <PublishJobCard />}
    </Box>
  );
}

function PublishJobCard() {
  const dispatch = useDispatch();
  const job = useSelector((s: RootState) => s.schema).job!;
  const done = job.items.filter((i) => i.status === 'done').length;
  const failed = job.items.filter((i) => i.status === 'failed').length;

  return (
    <Card variant="outlined" sx={{ mt: 2, borderColor: job.status === 'done' ? 'success.main' : job.status === 'conflict' ? 'warning.main' : failed ? 'error.main' : 'primary.main' }}>
      <CardContent>
        <Typography variant="subtitle1">
          发布任务 {job.newVersionLabel}
          <Chip
            size="small"
            sx={{ ml: 1 }}
            color={job.status === 'done' ? 'success' : job.status === 'conflict' ? 'warning' : failed ? 'error' : 'info'}
            label={
              job.status === 'done'
                ? `已完成（${done}/${job.items.length}）`
                : job.status === 'conflict'
                  ? '冲突：基线已被其他标签页推进'
                  : failed
                    ? `部分失败（${done}/${job.items.length}，失败 ${failed}）`
                    : `写入中（${done}/${job.items.length}）`
            }
          />
        </Typography>
        <Typography variant="caption" color="text.secondary">
          任务 {job.id} · 基线 revision {job.baseRevision} → {job.baseRevision + 1} · 开始 {job.startedAt}
        </Typography>
        <Box mt={1}>
          {job.items.map((item) => (
            <Stack key={item.id} direction="row" spacing={1} alignItems="center">
              <Chip
                size="small"
                color={item.status === 'done' ? 'success' : item.status === 'failed' ? 'error' : 'default'}
                label={item.status === 'done' ? '完成' : item.status === 'failed' ? '失败' : '待写'}
              />
              <Typography variant="body2">{item.label}</Typography>
              {item.error && <Typography variant="caption" color="error">{item.error}</Typography>}
            </Stack>
          ))}
        </Box>
        {job.status === 'failed' && (
          <Alert severity="error" sx={{ mt: 1 }} action={
            <Button color="inherit" size="small" onClick={() => {
              dispatch(retryJob());
              dispatch(driveJob(undefined));
            }}>重试未完成项</Button>
          }>
            写入失败，影响清单已保留。重试只会处理「待写 / 失败」项，已完成的冻结版和已登记的影响不会重复写。
          </Alert>
        )}
        {job.status === 'conflict' && (
          <Alert severity="warning" sx={{ mt: 1 }} action={
            <Button color="inherit" size="small" onClick={() => dispatch(rebasePlan())}>按最新基线重新预演</Button>
          }>
            后提交的发布检测到基线已从 revision {job.baseRevision} 推进到 {job.conflictActualRevision}。草稿保留，未覆盖任何已发布版本；请按最新基线重新预演后再确认。
          </Alert>
        )}
        {job.status === 'done' && (
          <Alert severity="success" sx={{ mt: 1 }} action={
            <Button color="inherit" size="small" onClick={() => dispatch(dismissJob())}>关闭</Button>
          }>
            冻结发布版已落账，{done - 1} 单受影响存量申请已登记影响戳记；旧解释未被改写。
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ============ 存量申请台账 ============

function EvaluationList({ evaluations }: { evaluations: RuleEvaluation[] }) {
  return (
    <Box mt={1}>
      {evaluations.map((e) => (
        <Alert
          key={e.ruleId}
          severity={e.passed ? 'success' : 'error'}
          sx={{ mb: 0.5, py: 0 }}
        >
          <Typography variant="body2">
            [{e.kind}] {e.description} — {e.message}
          </Typography>
        </Alert>
      ))}
    </Box>
  );
}

function SubmissionCard({ s }: { s: Submission }) {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const version = state.baseline.frozenVersions.find((v) => v.id === s.versionId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [mapId, setMapId] = useState(version?.id ?? state.baseline.frozenVersions[0]?.id ?? '');

  const legacy = !s.rulesVersion;
  const mapped = state.baseline.frozenVersions.find((v) => v.id === (s.classification?.mappedVersionId ?? mapId)) ??
    state.baseline.frozenVersions[0];
  const compat = compatRead(s, mapped);

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography fontWeight={700}>{s.label}</Typography>
          <Chip size="small" label={`结构版本 ${s.versionId}`} variant="outlined" />
          {s.rulesVersion
            ? <Chip size="small" color="primary" label={`规则版本 ${s.rulesVersion}（提交时冻结）`} />
            : <Chip size="small" color="warning" label="缺少规则版本 · 待归类" />}
          {s.status === 'passed' && <Chip size="small" color="success" label="通过" />}
          {s.status === 'intercepted' && <Chip size="small" color="error" label="拦截" />}
          {s.status === 'classified' && <Chip size="small" color="info" label="已归类（仅补解释）" />}
          <Box flexGrow={1} />
          <Button size="small" onClick={() => setOpen((x) => !x)}>{open ? '收起' : '查看版本账'}</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">{s.createdAt}</Typography>

        {open && (
          <Box mt={2}>
            <Typography variant="subtitle2">提交数据（按 {version?.label ?? s.versionId} 字段读取）</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {Object.entries(s.data).map(([k, v]) => (
                <Chip key={k} size="small" variant="outlined" label={`${version ? fieldLabelOf(version, k) : k}: ${v}`} />
              ))}
            </Stack>

            {s.validation && (
              <>
                <Typography variant="subtitle2" mt={2}>
                  提交时校验结果（{s.validation.evaluatedAt} 保存，之后发布不改写）
                </Typography>
                <EvaluationList evaluations={s.validation.evaluations} />
              </>
            )}

            {legacy && (
              <Box mt={2}>
                <Alert severity="warning" sx={{ mb: 1 }}>
                  历史数据缺少规则版本：按原表单兼容读取（只显示字段读数），不重算校验结论。归类只能补解释，不能回填/重算原结果。
                </Alert>
                <Typography variant="subtitle2">兼容读取（映射 {mapped.label}）</Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {compat.map((row) => (
                    <Chip
                      key={row.fieldId}
                      size="small"
                      color={row.known ? 'default' : 'warning'}
                      variant={row.known ? 'outlined' : 'filled'}
                      label={`${row.label}: ${row.value || '（空）'}${row.known ? '' : ' · 原数据无此字段'}`}
                    />
                  ))}
                </Stack>
                {s.status === 'pending_classify' ? (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2}>
                    <FormControl size="small" sx={{ minWidth: 200 }}>
                      <InputLabel>归类到的解释版本</InputLabel>
                      <Select label="归类到的解释版本" value={mapId} onChange={(e) => setMapId(e.target.value)}>
                        {state.baseline.frozenVersions.map((v) => (
                          <MenuItem key={v.id} value={v.id}>{v.label}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      size="small"
                      label="补充解释（不会改动原数据/原结果）"
                      value={note}
                      sx={{ flexGrow: 1 }}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <Button
                      variant="contained"
                      onClick={() => dispatch(classifySubmission({ id: s.id, note: note || '按原表单兼容读取，人工归类', mappedVersionId: mapId }))}
                    >
                      确认归类
                    </Button>
                  </Stack>
                ) : (
                  <Alert severity="info" sx={{ mt: 1 }}>
                    已归类到 {state.baseline.frozenVersions.find((v) => v.id === s.classification?.mappedVersionId)?.label}：
                    {s.classification?.note}（{s.classification?.at}）
                  </Alert>
                )}
              </Box>
            )}

            {s.stamps.length > 0 && (
              <Box mt={2}>
                <Typography variant="subtitle2">后续发布的影响登记（只标注，不重算）</Typography>
                {s.stamps.map((stamp) => (
                  <Alert key={stamp.jobId} severity="warning" sx={{ mb: 0.5 }}>
                    {stamp.at} · {stamp.fromVersionId} → {stamp.toVersionId}：
                    {stamp.kinds.map((k) => impactKindLabel(k)).join('、')}。{stamp.detail}
                  </Alert>
                ))}
              </Box>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function SubmissionsLedger() {
  const submissions = useSelector((s: RootState) => s.schema.baseline.submissions);
  const pending = submissions.filter((s) => !s.rulesVersion).length;
  return (
    <Box mt={2}>
      <Alert severity="info" sx={{ mb: 2 }}>
        每条申请保存其结构版本、规则版本（冻结快照）与提交时的校验解释；新发布只追加影响戳记，不改写旧解释。
        {pending > 0 && <b> 当前 {pending} 单缺少规则版本，标记为待归类。</b>}
      </Alert>
      {submissions.map((s) => (
        <SubmissionCard key={s.id} s={s} />
      ))}
    </Box>
  );
}

// ============ 运行态提交 ============

function RuntimePanel() {
  const dispatch = useDispatch();
  const state = useSelector((s: RootState) => s.schema);
  const version =
    state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId) ??
    state.baseline.frozenVersions[state.baseline.frozenVersions.length - 1];
  const form = useForm<Record<string, string>>({
    defaultValues: Object.fromEntries(version.fields.map((f) => [f.id, ''])),
  });
  // 冻结版本切换时（新发布落账）重置表单
  useEffect(() => {
    form.reset(Object.fromEntries(version.fields.map((f) => [f.id, ''])));
  }, [version.id, form]);
  const values = form.watch();
  const preview = useMemo(() => evalFormulaSafe(version, values), [version, values]);
  const [lastId, setLastId] = useState<string | null>(null);
  const last = state.baseline.submissions.find((s) => s.id === lastId) ?? null;

  return (
    <Box mt={2}>
      <Alert severity="info" sx={{ mb: 2 }}>
        运行态始终按当前已发布冻结版本（{version.label}，revision {version.revision}）提交；保存当时规则快照与逐条校验结果。
      </Alert>
      <Box
        component="form"
        onSubmit={form.handleSubmit((data) => {
          const id = `sub-${Date.now()}`;
          setLastId(id);
          dispatch(submitRuntime({ id, label: `运行态申请 ${id.slice(-4)}`, data }));
          form.reset();
        })}
      >
        <Stack spacing={2}>
          {version.fields.map((field) => (
            <TextField
              key={field.id}
              size="small"
              label={`${field.label}（${field.id}）`}
              type={field.type === 'number' ? 'number' : field.type === 'select' ? undefined : field.type}
              required={field.required}
              select={field.type === 'select'}
              defaultValue=""
              {...form.register(field.id)}
            >
              {field.type === 'select' &&
                field.options?.map((opt) => (
                  <MenuItem key={opt} value={opt}>{opt}</MenuItem>
                ))}
            </TextField>
          ))}
          {preview.length > 0 && (
            <Alert severity="info">
              {preview.map((p) => (
                <Typography key={p.targetId} variant="body2">
                  {fieldLabelOf(version, p.targetId)} 实时试算 = {p.text}
                </Typography>
              ))}
            </Alert>
          )}
          <Button type="submit" variant="contained">按 {version.id} 冻结规则提交</Button>
        </Stack>
      </Box>

      {last?.validation && (
        <Box mt={2}>
          <Alert severity={last.validation.status === 'passed' ? 'success' : 'error'}>
            已保存：规则版本 {last.rulesVersion} · {last.validation.status === 'passed' ? '通过' : '拦截'}（无论通过或拦截，解释均已冻结保存）
          </Alert>
          <EvaluationList evaluations={last.validation.evaluations} />
        </Box>
      )}
    </Box>
  );
}

function evalFormulaSafe(v: FormVersion, data: Record<string, string>) {
  return v.calcRules.map((rule) => {
    const result = evalFormula(rule.formula, data, v);
    return { targetId: rule.targetId, text: result.ok ? String(result.value) : `无法计算：${result.error}` };
  });
}

// ============ 外壳 ============

export default function App() {
  const { t } = useTranslation();
  const state = useSelector((s: RootState) => s.schema);
  const [tab, setTab] = useState(0);
  const active = state.baseline.frozenVersions.find((v) => v.id === state.baseline.activeVersionId);

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Typography variant="body2" sx={{ opacity: 0.85 }}>
            标签页 {state.tabId} · 基线 revision {state.baseline.revision} · 当前发布 {active?.label}
          </Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 6 }}>
            <DraftPanel />
          </Grid>
          <Grid size={{ xs: 12, lg: 6 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, v) => setTab(v)}>
                  <Tab label={t('publish')} />
                  <Tab label={`${t('simulate')}（${state.baseline.submissions.length}）`} />
                  <Tab label={t('runtime')} />
                </Tabs>
                {tab === 0 && <ImpactPreview />}
                {tab === 1 && <SubmissionsLedger />}
                {tab === 2 && <RuntimePanel />}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
