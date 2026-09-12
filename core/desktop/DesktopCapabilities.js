// @ts-check
'use strict';

/**
 * Capacidades de escritorio controlables por el usuario. Una regla
 * `capability:<id> = deny` desactiva toda la familia antes de solicitar una
 * aprobación puntual. Habilitarla no sustituye el consentimiento por acción.
 */
const DESKTOP_CAPABILITIES = Object.freeze([
  { id: 'applications', label: 'Aplicaciones' },
  { id: 'browser', label: 'Navegador y multimedia' },
  { id: 'screen', label: 'Pantalla y accesibilidad' },
  { id: 'pointer', label: 'Puntero y controles' },
  { id: 'keyboard', label: 'Teclado en controles observados' },
  { id: 'processes', label: 'Procesos' },
  { id: 'camera', label: 'Cámara' },
]);

/** @type {Readonly<Record<string, string>>} */
const TOOL_CAPABILITIES = Object.freeze({
  list_apps: 'applications',
  launch_app: 'applications',
  window_list: 'applications',
  window_focus: 'applications',
  window_close: 'applications',
  ui_get_state: 'screen',
  ui_wait: 'screen',
  open_website: 'browser',
  play_media: 'browser',
  browser: 'browser',
  personal_browser_detect: 'browser',
  personal_browser_link: 'browser',
  personal_browser_status: 'browser',
  personal_browser_close: 'browser',
  personal_browser_login: 'browser',
  desktop_snapshot: 'screen',
  ocr_query: 'screen',
  desktop_screenshot: 'screen',
  pointer_click: 'pointer',
  ui_click: 'pointer',
  ui_select: 'pointer',
  ui_scroll: 'pointer',
  ui_type: 'keyboard',
  ui_press: 'keyboard',
  process_list: 'processes',
  process_stop: 'processes',
  camera_status: 'camera',
  open_camera: 'camera',
});

/** @param {unknown} tool @returns {string|null} */
function capabilityForTool(tool) {
  return TOOL_CAPABILITIES[String(tool || '')] || null;
}

/** @param {unknown} capability @returns {string} */
function capabilityPermissionTool(capability) {
  return `capability:${String(capability || '')}`;
}

module.exports = {
  DESKTOP_CAPABILITIES,
  TOOL_CAPABILITIES,
  capabilityForTool,
  capabilityPermissionTool,
};
