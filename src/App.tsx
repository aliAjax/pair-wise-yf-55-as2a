import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl,
  FormControlLabel, Grid, IconButton, InputLabel, MenuItem, Select, Stack, Switch, Tab,
  Tabs, TextField, Toolbar, Typography
} from '@mui/material';
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import PendingOutlinedIcon from '@mui/icons-material/PendingOutlined';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField, addRule, classifyLegacy, confirmPublish, detectCycle, evaluateCondition,
  offlineField, previewImpact, rebaseDraft, removeRule, reorderFields, retryPublish,
  selectPreview, setFaultInjection, simulateOtherTabPublish, submitRuntime as submitRuntimeAction, updateRule,
  type FormField, type LinkRule, type RootState, type RuleEffect, type Submission
} from './store';

const effectLabel: Record<RuleEffect, string> = { show: '显示', require: '必填', compute: '计算依赖' };
const impactLabel = { 'field-offline': '字段下线', 'rule-redirect': '规则改向', 'circular-dependency': '计算成环' } as const;
const impactColor = { 'field-offline': 'warning', 'rule-redirect': 'info', 'circular-dependency': 'error' } as const;

function StatusChip({ status }: { status: Submission['status'] }) {
  return (
    status === 'accepted'
      ? <Chip size="small" color="success" icon={<CheckCircleOutlineIcon />} label="已受理" />
      : <Chip size="small" color="error" icon={<ErrorOutlineIcon />} label="已拦截" />
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const draft = state.versions.find((v) => v.id === state.previewVersionId && v.status === 'draft');
  const active = state.versions.find((v) => v.id === state.activeVersionId);
  const published = state.versions.filter((v) => v.status === 'published');
  const submissions = state.submissions;
  const latestPreview = state.impactPreviews[state.impactPreviews.length - 1];
  const cycle = useMemo(() => (draft ? detectCycle(draft.rules) : []), [draft]);
  const sensors = useSensors(useSensor(PointerSensor));

  const [tab, setTab] = useState(0);
  const [ruleForm, setRuleForm] = useState<Omit<LinkRule, 'id'>>({ fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: '' });
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [runtimeVersionId, setRuntimeVersionId] = useState(state.activeVersionId);
  const [runtimeData, setRuntimeData] = useState<Record<string, unknown>>({});
  const [runtimeResult, setRuntimeResult] = useState<Submission | null>(null);
  const [classifyNote, setClassifyNote] = useState<Record<string, string>>({});

  const runtimeVersion = state.versions.find((v) => v.id === runtimeVersionId && v.status === 'published');
  const runtimeValidation = useMemo(() => {
    if (!runtimeVersion) return null;
    const reasons: Submission['interceptReasons'] = [];
    const results = runtimeVersion.fields.map((field) => {
      if (field.offline) return { fieldId: field.id, valid: true, reasons: [] };
      const fieldReasons: Submission['interceptReasons'] = [];
      let required = field.required;
      let visible = true;
      for (const rule of runtimeVersion.rules) {
        if (rule.effect === 'require' && rule.targetId === field.id && evaluateCondition(rule, runtimeData)) {
          required = true;
          fieldReasons.push({ ruleId: rule.id, ruleSnapshot: rule, message: `联动规则要求必填：${rule.fieldId} ${rule.operator === 'equals' ? '等于' : '非空'} ${rule.value}` });
        }
        if (rule.effect === 'show' && rule.targetId === field.id && !evaluateCondition(rule, runtimeData)) visible = false;
      }
      const value = runtimeData[field.id];
      const isEmpty = value === undefined || value === null || value === '';
      const invalid = visible && required && isEmpty;
      if (invalid) {
        if (fieldReasons.length === 0) fieldReasons.push({ ruleId: '__base__', ruleSnapshot: null, message: '基础必填字段未填写' });
        reasons.push(...fieldReasons);
      }
      return { fieldId: field.id, valid: !invalid, reasons: fieldReasons };
    });
    return { status: reasons.length ? 'intercepted' : 'accepted' as const, reasons, results };
  }, [runtimeVersion, runtimeData]);

  function dragEnd(event: DragEndEvent) {
    if (!draft || !event.over || event.active.id !== event.over.id) return;
    dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  function submitRule() {
    if (!draft || !ruleForm.targetId) return;
    if (editingRuleId) dispatch(updateRule({ ...ruleForm, id: editingRuleId }));
    else dispatch(addRule(ruleForm));
    setEditingRuleId(null);
    setRuleForm({ fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: '' });
  }

  function startEditRule(rule: LinkRule) {
    setEditingRuleId(rule.id);
    setRuleForm({ fieldId: rule.fieldId, operator: rule.operator, value: rule.value, effect: rule.effect, targetId: rule.targetId });
  }

  function handleSubmitRuntime() {
    if (!runtimeVersion) return;
    dispatch(submitRuntimeAction({ versionId: runtimeVersion.id, data: runtimeData }));
    const sub = state.submissions[state.submissions.length - 1];
    setRuntimeResult(sub ?? null);
  }

  const legacySubs = submissions.filter((s) => s.legacy);
  const runtimeSubs = submissions.filter((s) => !s.legacy);

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <FormControlLabel
            control={<Switch checked={state.faultInjection} onChange={(e) => dispatch(setFaultInjection(e.target.checked))} color="default" />}
            label={<Typography variant="body2">模拟写入故障</Typography>}
            sx={{ mr: 2 }}
          />
          <Button color="inherit" variant="outlined" onClick={() => dispatch(previewImpact())}>影响预演</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          {/* 左：草稿编排 */}
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">草稿编排</Typography>
                    <Typography variant="body2" color="text.secondary">
                      当前草稿 {draft?.label} · 基线 {draft?.baselineVersionId} · 最新已发布 {active?.id}
                      {draft && draft.baselineVersionId !== state.activeVersionId && <Chip size="small" color="warning" label="基线已过期" sx={{ ml: 1 }} />}
                    </Typography>
                  </div>
                  <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>
                </Stack>
                {cycle.length > 0 && (
                  <Alert severity="error" icon={<WarningAmberIcon />} sx={{ mb: 2 }}>
                    计算依赖成环：{cycle.join(' → ')}。成环版本不可发布，请移除或改向计算规则。
                  </Alert>
                )}
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                  <SortableContext items={draft?.fields.map((f) => f.id) ?? []} strategy={verticalListSortingStrategy}>
                    <Stack>
                      {draft?.fields.map((field) => (
                        <Card key={field.id} variant="outlined" sx={{ mb: 1, opacity: field.offline ? 0.55 : 1 }}>
                          <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '14px !important' }}>
                            <div>
                              <Typography fontWeight={700}>{field.label} {field.offline && <Chip size="small" label="已下线" />}</Typography>
                              <Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}{field.options ? ` · ${field.options.join('/')}` : ''}</Typography>
                            </div>
                            <Stack direction="row" spacing={1}>
                              <Button size="small" color={field.offline ? 'primary' : 'warning'} onClick={() => dispatch(offlineField(field.id))}>
                                {field.offline ? '恢复上线' : '下线'}
                              </Button>
                              <SortableHandle id={field.id} />
                            </Stack>
                          </CardContent>
                        </Card>
                      ))}
                    </Stack>
                  </SortableContext>
                </DndContext>
                <Divider sx={{ my: 3 }} />
                <Typography variant="h6" mb={1}>联动与计算规则</Typography>
                <Stack spacing={1} mb={2}>
                  {draft?.rules.map((rule) => (
                    <Alert key={rule.id} severity={rule.effect === 'compute' ? 'warning' : 'info'}
                      action={
                        <Stack direction="row">
                          <IconButton size="small" onClick={() => startEditRule(rule)}><EditOutlinedIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => dispatch(removeRule(rule.id))}><DeleteOutlineIcon fontSize="small" /></IconButton>
                        </Stack>
                      }>
                      {rule.effect === 'compute'
                        ? `计算依赖：${rule.targetId} 依赖 ${rule.fieldId}`
                        : `${rule.fieldId} ${rule.operator === 'equals' ? '等于' : '非空'} ${rule.value || ''} 时，${effectLabel[rule.effect]} ${rule.targetId}`}
                    </Alert>
                  ))}
                </Stack>
                <Card variant="outlined" sx={{ p: 2 }}>
                  <Grid container spacing={2} alignItems="center">
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <FormControl size="small" fullWidth><InputLabel>效果</InputLabel>
                        <Select label="效果" value={ruleForm.effect} onChange={(e) => setRuleForm({ ...ruleForm, effect: e.target.value as RuleEffect })}>
                          <MenuItem value="show">显示</MenuItem><MenuItem value="require">必填</MenuItem><MenuItem value="compute">计算依赖</MenuItem>
                        </Select>
                      </FormControl>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <FormControl size="small" fullWidth><InputLabel>源字段</InputLabel>
                        <Select label="源字段" value={ruleForm.fieldId} onChange={(e) => setRuleForm({ ...ruleForm, fieldId: e.target.value })}>
                          {draft?.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
                        </Select>
                      </FormControl>
                    </Grid>
                    {ruleForm.effect !== 'compute' && (
                      <>
                        <Grid size={{ xs: 6, sm: 2 }}>
                          <FormControl size="small" fullWidth><InputLabel>条件</InputLabel>
                            <Select label="条件" value={ruleForm.operator} onChange={(e) => setRuleForm({ ...ruleForm, operator: e.target.value as 'equals' | 'notEmpty' })}>
                              <MenuItem value="equals">等于</MenuItem><MenuItem value="notEmpty">非空</MenuItem>
                            </Select>
                          </FormControl>
                        </Grid>
                        <Grid size={{ xs: 6, sm: 2 }}>
                          <TextField size="small" fullWidth label="值" value={ruleForm.value} onChange={(e) => setRuleForm({ ...ruleForm, value: e.target.value })} />
                        </Grid>
                      </>
                    )}
                    <Grid size={{ xs: 12, sm: ruleForm.effect !== 'compute' ? 2 : 3 }}>
                      <FormControl size="small" fullWidth><InputLabel>目标字段</InputLabel>
                        <Select label="目标字段" value={ruleForm.targetId} onChange={(e) => setRuleForm({ ...ruleForm, targetId: e.target.value })}>
                          {draft?.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
                        </Select>
                      </FormControl>
                    </Grid>
                    <Grid size={{ xs: 12 }}>
                      <Button variant="outlined" fullWidth onClick={submitRule}>{editingRuleId ? '保存改向' : '添加规则'}</Button>
                    </Grid>
                  </Grid>
                </Card>
              </CardContent>
            </Card>
          </Grid>

          {/* 右：标签页 */}
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, v) => setTab(v)}>
                  <Tab label="影响预演" />
                  <Tab label="版本账" />
                  <Tab label="运行态" />
                  <Tab label="提交账" />
                </Tabs>

                {/* 影响预演 */}
                {tab === 0 && (
                  <Box mt={2}>
                    <Stack direction="row" spacing={1} flexWrap="wrap" mb={2}>
                      <Button variant="contained" onClick={() => dispatch(previewImpact())}>重新预演</Button>
                      <Button variant="contained" color="success" disabled={!latestPreview || latestPreview.status !== 'preview'} onClick={() => dispatch(confirmPublish())}>确认并发布</Button>
                      <Button variant="outlined" onClick={() => dispatch(simulateOtherTabPublish())}>模拟另一标签页发布</Button>
                      {latestPreview?.status === 'conflict' && <Button variant="outlined" color="warning" onClick={() => dispatch(rebaseDraft())}>重新基线</Button>}
                      {latestPreview && (latestPreview.status === 'partial' || latestPreview.status === 'conflict') && (
                        <Button variant="outlined" color="primary" onClick={() => dispatch(retryPublish(latestPreview.id))}>重试未完成项</Button>
                      )}
                    </Stack>
                    {!latestPreview && <Alert severity="info">点击「影响预演」生成草稿对存量申请的影响清单。</Alert>}
                    {latestPreview && (
                      <>
                        <Alert severity={latestPreview.status === 'conflict' ? 'warning' : latestPreview.status === 'blocked' ? 'error' : latestPreview.status === 'published' ? 'success' : 'info'} sx={{ mb: 2 }}>
                          状态：{previewStatusText(latestPreview.status)}
                          {latestPreview.frozenVersionId && <> · 冻结版本 {latestPreview.frozenVersionId}</>}
                          {latestPreview.status === 'partial' && <> · 已处理 {latestPreview.processedSubmissionIds.length}/{latestPreview.items.length} 项</>}
                        </Alert>
                        {latestPreview.status === 'conflict' && (
                          <Alert severity="warning" sx={{ mb: 2 }}>
                            基线冲突：草稿基线 {latestPreview.baselineVersionId} 已不是最新发布版本 {state.activeVersionId}。草稿保留，不会覆盖已发布版本。请重新基线后再发布。
                          </Alert>
                        )}
                        {latestPreview.items.length === 0 && latestPreview.status !== 'blocked' && <Alert severity="success">无受影响的存量申请，可直接发布。</Alert>}
                        <Stack spacing={1}>
                          {latestPreview.items.map((item, idx) => {
                            const processed = latestPreview.processedSubmissionIds.includes(item.submissionId);
                            return (
                              <Card key={`${item.submissionId}-${idx}`} variant="outlined" sx={{ p: 1.5, opacity: processed ? 0.7 : 1 }}>
                                <Stack direction="row" justifyContent="space-between" alignItems="center">
                                  <Box>
                                    <Chip size="small" color={impactColor[item.type]} label={impactLabel[item.type]} sx={{ mr: 1 }} />
                                    <Typography variant="body2" component="span">{item.submissionLabel}</Typography>
                                  </Box>
                                  {processed && <Chip size="small" color="success" label="已入账" />}
                                </Stack>
                                <Typography variant="body2" color="text.secondary" mt={0.5}>{item.detail}</Typography>
                              </Card>
                            );
                          })}
                        </Stack>
                      </>
                    )}
                  </Box>
                )}

                {/* 版本账 */}
                {tab === 1 && (
                  <Box mt={2}>
                    <Alert severity="info" sx={{ mb: 2 }}>已发布版本冻结保存，后续发布不改写旧解释。</Alert>
                    <Stack spacing={1}>
                      {published.slice().reverse().map((v) => (
                        <Card key={v.id} variant="outlined" sx={{ p: 1.5 }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography fontWeight={700}>{v.label}</Typography>
                            <Chip size="small" color="primary" label={v.id} />
                          </Stack>
                          <Typography variant="body2" color="text.secondary">
                            发布于 {v.publishedAt} · 基线 {v.baselineVersionId ?? '—'} · {v.fields.length} 字段 · {v.rules.length} 规则
                          </Typography>
                        </Card>
                      ))}
                    </Stack>
                  </Box>
                )}

                {/* 运行态 */}
                {tab === 2 && (
                  <Box mt={2}>
                    <FormControl size="small" fullWidth sx={{ mb: 2 }}>
                      <InputLabel>提交版本</InputLabel>
                      <Select label="提交版本" value={runtimeVersionId} onChange={(e) => { setRuntimeVersionId(e.target.value); setRuntimeData({}); setRuntimeResult(null); }}>
                        {published.map((v) => <MenuItem key={v.id} value={v.id}>{v.label}（{v.id}）</MenuItem>)}
                      </Select>
                    </FormControl>
                    {runtimeVersion && (
                      <Stack spacing={2}>
                        {runtimeVersion.fields.map((field) => {
                          if (field.offline) return null;
                          const fv = fieldState(runtimeVersion, field, runtimeData);
                          if (!fv.visible) return null;
                          const validation = runtimeValidation?.results.find((r) => r.fieldId === field.id);
                          return (
                            <Box key={field.id}>
                              {field.type === 'select' ? (
                                <FormControl size="small" fullWidth error={validation ? !validation.valid : false}>
                                  <InputLabel>{field.label}{fv.required ? ' *' : ''}</InputLabel>
                                  <Select label={field.label} value={String(runtimeData[field.id] ?? '')} onChange={(e) => setRuntimeData({ ...runtimeData, [field.id]: e.target.value })}>
                                    <MenuItem value="">（空）</MenuItem>
                                    {field.options?.map((opt) => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                                  </Select>
                                </FormControl>
                              ) : (
                                <TextField
                                  size="small" fullWidth
                                  label={`${field.label}${fv.required ? ' *' : ''}`}
                                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                                  InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
                                  value={runtimeData[field.id] ?? ''}
                                  error={validation ? !validation.valid : false}
                                  helperText={validation && !validation.valid ? validation.reasons.map((r) => r.message).join('；') : undefined}
                                  onChange={(e) => setRuntimeData({ ...runtimeData, [field.id]: field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
                                />
                              )}
                            </Box>
                          );
                        })}
                        {runtimeValidation && runtimeValidation.reasons.length > 0 && (
                          <Alert severity="error" icon={<ErrorOutlineIcon />}>
                            实时拦截原因（提交时冻结）：
                            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                              {runtimeValidation.reasons.map((r, i) => <li key={i}>{r.message}</li>)}
                            </ul>
                          </Alert>
                        )}
                        <Button variant="contained" onClick={handleSubmitRuntime}>按当前版本提交</Button>
                        {runtimeResult && (
                          <Alert severity={runtimeResult.status === 'accepted' ? 'success' : 'warning'}>
                            已提交（{runtimeResult.id}）· 状态：{runtimeResult.status === 'accepted' ? '已受理' : '已拦截'} · 规则与校验结果已冻结。
                          </Alert>
                        )}
                      </Stack>
                    )}
                  </Box>
                )}

                {/* 提交账 */}
                {tab === 3 && (
                  <Box mt={2}>
                    <Typography variant="subtitle2" gutterBottom>运行态提交（规则与校验结果冻结）</Typography>
                    <Stack spacing={1} mb={3}>
                      {runtimeSubs.map((sub) => (
                        <Card key={sub.id} variant="outlined" sx={{ p: 1.5 }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography variant="body2" fontWeight={700}>{sub.versionLabel} · {sub.submittedAt.slice(0, 16).replace('T', ' ')}</Typography>
                            <StatusChip status={sub.status} />
                          </Stack>
                          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{JSON.stringify(sub.data)}</Typography>
                          {sub.interceptReasons.length > 0 && (
                            <Alert severity="warning" sx={{ mt: 1 }} icon={<WarningAmberIcon />}>
                              拦截解释（冻结）：{sub.interceptReasons.map((r) => r.message).join('；')}
                            </Alert>
                          )}
                        </Card>
                      ))}
                    </Stack>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2" gutterBottom>历史数据（缺规则版本 · 待归类）</Typography>
                    <Stack spacing={1}>
                      {legacySubs.map((sub) => (
                        <Card key={sub.id} variant="outlined" sx={{ p: 1.5 }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography variant="body2" fontWeight={700}>{sub.versionLabel} · {sub.submittedAt.slice(0, 10)}</Typography>
                            {sub.classificationStatus === 'classified'
                              ? <Chip size="small" color="success" icon={<CheckCircleOutlineIcon />} label="已归类" />
                              : <Chip size="small" color="default" icon={<PendingOutlinedIcon />} label="待归类" />}
                          </Stack>
                          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{JSON.stringify(sub.data)}</Typography>
                          {sub.classificationStatus === 'classified' ? (
                            <Alert severity="info" sx={{ mt: 1 }}>归类说明（仅补充解释，未重算原结果）：{sub.classificationNote}</Alert>
                          ) : (
                            <Stack direction="row" spacing={1} mt={1}>
                              <TextField size="small" fullWidth placeholder="补充归类说明（不重算原结果）" value={classifyNote[sub.id] ?? ''} onChange={(e) => setClassifyNote({ ...classifyNote, [sub.id]: e.target.value })} />
                              <Button size="small" variant="outlined" onClick={() => dispatch(classifyLegacy({ submissionId: sub.id, note: classifyNote[sub.id] ?? '' }))}>归类</Button>
                            </Stack>
                          )}
                        </Card>
                      ))}
                    </Stack>
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}

function SortableHandle({ id }: { id: string }) {
  const sortable = useSortable({ id });
  return <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>;
}

function fieldState(version: { fields: FormField[]; rules: LinkRule[] }, field: FormField, data: Record<string, unknown>) {
  let required = field.required;
  let visible = true;
  for (const rule of version.rules) {
    if (rule.effect === 'require' && rule.targetId === field.id && evaluateCondition(rule, data)) required = true;
    if (rule.effect === 'show' && rule.targetId === field.id && !evaluateCondition(rule, data)) visible = false;
  }
  return { required, visible };
}

function previewStatusText(status: string): string {
  switch (status) {
    case 'preview': return '已预演，待确认';
    case 'writing': return '写入中';
    case 'partial': return '部分写入（故障后保留清单，可重试）';
    case 'published': return '已发布（冻结）';
    case 'conflict': return '基线冲突';
    case 'blocked': return '阻塞（计算成环）';
    default: return status;
  }
}
