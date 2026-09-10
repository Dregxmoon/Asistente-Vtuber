# Control del escritorio (`core/desktop/`)

Automatización local separada del navegador web. Expone capacidades de aplicaciones, ventanas,
árboles accesibles, pantalla, puntero, teclado, procesos y cámara mediante herramientas de alto
impacto gobernadas por `AgentLoop` y `PermissionManager`.

## Backends y alcance

| Capacidad                               | Linux                                | Windows                           | macOS            |
| --------------------------------------- | ------------------------------------ | --------------------------------- | ---------------- |
| Aplicaciones y navegador predeterminado | `.desktop`, `gtk-launch`, `xdg-open` | menú Inicio y helpers PowerShell  | `open`           |
| Ventanas y controles accesibles         | AT-SPI2                              | UI Automation                     | no implementado  |
| Captura y clic visual                   | Electron + AT-SPI2                   | Electron + Win32                  | no implementado  |
| Procesos                                | `ps` + `SIGTERM`                     | `Get-Process` + señal del runtime | `ps` + `SIGTERM` |
| Cámara                                  | abre una aplicación conocida         | abre Windows Camera               | abre Photo Booth |

`camera_status` consulta el estado que expone Electron y `open_camera` inicia una aplicación; Kaoru
no implementa captura silenciosa de audio o video. `process_list` devuelve sólo PID y nombre, y
`process_stop` confirma que se solicitó la señal, no que el proceso haya terminado.

## Observación antes de acción

- `desktop_snapshot` crea referencias efímeras a nodos accesibles. Las acciones `ui_*` y
  `window_*` deben consumir la observación vigente y después comprobar una postcondición cuando sea
  posible.
- `desktop_screenshot` crea un `captureId` efímero. `pointer_click` acepta únicamente coordenadas de
  esa captura, expira a los 30 segundos y consume el ID para impedir clics reutilizados o a ciegas.
- Las capturas pueden enviarse al proveedor LLM activo si el modelo admite visión. El aviso público
  de privacidad describe esta transferencia.

## Permisos

`DesktopCapabilities.js` agrupa herramientas en aplicaciones, navegador, pantalla, puntero, teclado,
procesos y cámara. Una regla `capability:<id> = deny` bloquea la familia antes de cualquier ejecución.
Habilitar una familia no crea un permiso general: siguen aplicándose la clasificación de impacto, la
regla específica y la aprobación de sesión.

## Verificación

Ejecuta `tests/test_desktop_control.js`, `tests/test_desktop_automation.js`,
`tests/test_application_tool_parity.js` y la matriz Linux/Windows de `.github/workflows/ci.yml`.
