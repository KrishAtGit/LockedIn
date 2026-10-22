import { getFocusRecords } from '../lib/focus'
import { buildReport } from '../lib/report'
import { getDaily, getExcuses, getSettings, isAllowlisted, limitKey } from '../lib/storage'
import { renderReport } from './report-view'

async function init(): Promise<void> {
  const settings = await getSettings()
  const report = buildReport({
    usage: await getDaily('usage'),
    study: await getDaily('study'),
    focusLog: await getFocusRecords(),
    excuses: await getExcuses(),
    keyOf: (domain) => limitKey(settings, domain),
    isStudySite: (domain) => isAllowlisted(settings, domain),
  })
  renderReport(report)
}

void init()
