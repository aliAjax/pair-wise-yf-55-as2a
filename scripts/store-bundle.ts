export { store } from '../src/store';
import * as sliceExports from '../src/store';
export const actions = {
  addField: sliceExports.addField,
  ensureDraft: sliceExports.ensureDraft,
  runImpactPreview: sliceExports.runImpactPreview,
  confirmPublish: sliceExports.confirmPublish,
  driveJob: sliceExports.driveJob,
  retryJob: sliceExports.retryJob,
  baselineChanged: sliceExports.baselineChanged,
  rebasePlan: sliceExports.rebasePlan,
  classifySubmission: sliceExports.classifySubmission,
  submitRuntime: sliceExports.submitRuntime,
  offlineField: sliceExports.offlineField,
  upsertCalcRule: sliceExports.upsertCalcRule,
};
