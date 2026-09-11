---
description: 'Abrir una app de escritorio (Writer, editores) y escribir texto largo por bloques con verificación y guardado confirmado'
version: '1.0.0'
domains: ['desktop', 'system']
---

# Office Writer Skill

Para peticiones como "abre mi libreoffice writer y escribe un ensayo sobre X".

## Receta (en orden, una herramienta por vez)

1. **Resolver nombre**: `list_apps` con la consulta si el nombre no es exacto
   (vale `writer`, `libreoffice`, `word`, `notepad`...). Luego `launch_app`
   con el nombre exacto encontrado.
2. **Esperar ventana**: `window_list` o `desktop_snapshot` filtrando por la app.
   NO actuar hasta ver la ventana (las apps tardan segundos en abrir).
3. **Escribir por bloques**: `ui_type` con trozos de como máximo ~3000
   caracteres sobre la referencia `ui-N` observada. Textos largos en UNA sola
   llamada se truncan o fallan: divide siempre.
4. **Verificar cada bloque**: `ui_get_state` o `ui_wait` con `expected`
   (nombre/rol/estado esperado). Las refs expiran: re-observa (`desktop_snapshot`
   de nuevo) cuando cambie la interfaz o pasen ~60 segundos.
5. **Guardar y confirmar**: envía guardado (`ui_press` con la tecla que
   corresponda) y confirma el archivo en disco (ruta + tamaño > 0) cuando la
   app lo soporte. Si el guardado no se pudo verificar, dilo en el cierre.
6. **Responder**: confirma qué se escribió, dónde quedó guardado y qué quedó
   sin verificar (si aplica). Honestidad kawaii: sin `intentVerified` no hay
   "¡listo, ya está!".

## Reglas

- Ninguna app está predefinida: la receta vale para Writer, editores, blocs de
  notas o cualquier app con campo editable accesible.
- Jamás inventar `observationId` ni `ref`: siempre vienen de la última
  observación vigente.
- Si AT-SPI no ve la ventana (Wayland) o la app no aparece: informa el
  diagnóstico (`desktop_capabilities`, `window_list`) y propone alternativa.
