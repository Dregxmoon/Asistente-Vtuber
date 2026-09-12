---
description: 'Buscar un producto en una tienda web y verificar precio y disponibilidad con evidencia citada (receta managed verificable). EN: search a product in a web store and verify price and availability with quoted evidence. Ejemplos: abre amazon y busca, dime si está disponible. EN examples: open amazon and check, is it in stock'
version: '1.0.0'
domains: ['web', 'desktop']
---

# Shop Lookup Skill

Para peticiones como "abre amazon y dime si el manga X tomo 18 está disponible".

## Receta (en orden, una herramienta por vez)

1. **Resolver y abrir**: `open_website` con el nombre de la tienda (TARGET).
   Se resuelve solo (URL → alias → búsqueda + UrlGuard). NO necesita URL previa.
2. **Navegar verificable**: `browser` con `mode: "managed"`, `action: "navigate"`
   a la URL resuelta si hace falta tomar control (external queda ciego).
3. **Observar**: `browser` `action: "snapshot"` (o `tabs`) y anotar
   `sessionId`, `pageId`, `expectedOrigin`.
4. **Buscar**: `browser` `action: "type"` en el buscador + `action: "click"` en
   buscar, repitiendo el triple observado. Re-observar después de cada acción.
5. **Leer evidencia**: `browser` `action: "get_text"` del resultado (precio,
   disponibilidad, título). Sin este paso NO se puede afirmar nada.
6. **Responder**: citar precio + disponibilidad + URL. Si hubo CAPTCHA, login o
   el producto no aparece: decirlo y dejar el navegador abierto para continuar
   manual. Nunca inventar disponibilidad.

## Reglas

- Verificar ⇒ managed. `external` solo sirve para "solo ábrelo".
- Ninguna tienda está predefinida: la misma receta vale para amazon, mercado
  libre, ebay o cualquier tienda.
- `expectedUrl` en clicks que cambian de página cuando sea predecible.
- Idioma: la receta es independiente del idioma del usuario; reporta en su idioma.
