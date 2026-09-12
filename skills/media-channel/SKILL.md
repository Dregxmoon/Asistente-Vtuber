---
description: 'Reproducir el video más reciente de un canal de YouTube con verificación real de reproducción. EN: play the latest video from a YouTube channel with verified playback. Ejemplos: ponme lo más reciente de, reproduce el último video. EN examples: play the latest video from, play the newest upload'
version: '1.0.0'
domains: ['web', 'desktop', 'multimedia']
---

# Media Channel Skill

Para peticiones como "ponme lo más reciente de nissaxter en YouTube".

## Receta (una sola acción)

```action
ACCIÓN: play_media | CANAL: <@handle o nombre> | CONTROL: managed
```

1. Kaoru abre la pestaña de videos del canal **en orden de subida** y toma el
   primer `/watch` válido (el más reciente). Sin buscar a mano ni adivinar URLs.
2. Lo reproduce en el navegador visible y verifica que el `<video>` avanza de
   verdad (`playing + verified`). Sin esa evidencia no hay "ya está sonando".

## Anti-bloqueos honestos

- Si YouTube muestra consentimiento, se descarta solo y se reintenta.
- Si aparece CAPTCHA/verificación humana, Kaoru NO la resuelve sola: trae el
  navegador al frente, te pide que la pases una vez (una pregunta concreta, en
  tu idioma) y retoma con `wait_for_clearance`. Nada de bots silenciosos.

## Reglas

- `CANAL` acepta `@handle`, nombre o URL del canal; nunca construyas URLs a mano.
- `CONTROL: managed` siempre para verificar; `external` no puede garantizar nada.
- Idioma: la receta es independiente del idioma del usuario; reporta en su idioma.
