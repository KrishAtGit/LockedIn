export type Target = 'chrome' | 'firefox'

export function buildManifest(target: Target) {
  const base = {
    manifest_version: 3,
    name: 'LockedIn',
    version: '0.1.0',
    description:
      'Study-aware focus limits',
    permissions: ['tabs', 'storage', 'alarms', 'idle', 'notifications'],
    // Requested only when you turn on the AI backend in settings, for that server's address.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    icons: { 
      16: 'icons/icon-16.png', 
      32: 'icons/icon-32.png', 
      48: 'icons/icon-48.png', 
      128: 'icons/icon-128.png' 
    },
    action: { 
      default_popup: 'pages/popup.html', 
      default_title: 'LockedIn' 
    },
    options_ui: { 
      page: 'pages/options.html', 
      open_in_tab: true 
    },
    // Draws the floating timer on every website.
    content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['content/timer.js'], run_at: 'document_idle' }],
  }

  if (target === 'firefox') {
    return {
      ...base,
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: { 
          id: 'lockedin@krishjangra', 
          strict_min_version: '115.0' 
        },
      },
    }
  }

  return { ...base, background: { service_worker: 'background.js', type: 'module' } }
}
