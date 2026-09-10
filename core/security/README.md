# Seguridad y permisos (`core/security/`)

Control granulado de qué herramientas puede usar el agente, sobre qué rutas y con qué nivel de
consentimiento, en el patrón de opencode: `allow` / `ask` / `deny`.

## `PermissionManager.js`

`class PermissionManager` — reglas **allow/ask/deny por tool + path**, persistidas en JSON
(never-throw; cae a memoria si la escritura falla y nunca rompe el arranque).

Resolución por especificidad, de más a menos concreta:

1. tool + prefijo de ruta exacto
2. tool exacta
3. `*` + ruta
4. `*` (global)
5. default (configuración)

Las reglas se gestionan desde el panel de permisos del chat y la Control API
(`core/core/permissions.js`: `permissionsSetRule` · `permissionsRemoveRule` · `permissionsList`).

## Capacidades de escritorio y aprobaciones de sesión

`core/desktop/DesktopCapabilities.js` asigna herramientas a siete familias: aplicaciones,
navegador, pantalla, puntero, teclado, procesos y cámara. El panel persiste una regla virtual
`capability:<id>`; `deny` funciona como interruptor de emergencia para toda la familia. Volver a
habilitarla deja la regla en `ask`: nunca convierte por sí solo acciones de alto impacto en `allow`.

`SessionApprovals.js` crea patrones ligados a parámetros relevantes (host y modo del navegador,
consulta multimedia, PID, captura/coordenadas u observación/referencia). Las aprobaciones viven sólo
durante la sesión y no sustituyen la validación que realiza cada executor.

## Límites

- La aprobación confirma intención para los parámetros mostrados; no garantiza el resultado externo.
- El sandbox de comandos y el sandbox del renderer son controles distintos y dependen de plataforma.
- Plugins y servidores MCP amplían la superficie de confianza y requieren revisar su procedencia y
  permisos.

## Etiqueta

```
core/security
        ├── PermissionManager.js   # Reglas allow/ask/deny por tool+path
        └── README.md
```

Verificación: `test_permissions`, `test_session_approvals`, `test_server_security` y
`test_untrusted_content`. El confinamiento al workspace aplica a herramientas de archivos; no debe
generalizarse a navegador, procesos, aplicaciones ni integraciones externas.
