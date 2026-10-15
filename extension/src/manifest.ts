export type Target = 'chrome' | 'firefox'

export function buildManifest(target: Target) {
  const base = {
    manifest_version: 3,
    name: 'LockedIn',
    version: '0.1.0',
    description:
      'Study-aware focus limits: knows a lecture from a rabbit hole, and asks why before it blocks.',
    permissions: ['tabs', 'storage', 'alarms', 'idle', 'notifications'],
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: { default_popup: 'pages/popup.html', default_title: 'LockedIn' },
    options_ui: { page: 'pages/options.html', open_in_tab: true },
  }

  if (target === 'firefox') {
    return {
      ...base,
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: { id: 'lockedin@krishjangra', strict_min_version: '115.0' },
      },
    }
  }

  return { ...base, background: { service_worker: 'background.js', type: 'module' } }
}
