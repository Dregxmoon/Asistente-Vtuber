# Idiomas y mantenimiento

[← Centro de documentación](../README.md)

## Fuente canónica

El español es el idioma canónico de Kaoru. <code>README.md</code>, <code>docs/arquitectura.md</code> y los READMEs internos en <code>core/</code>, <code>ipc/</code>, <code>src/</code>, <code>infrastructure/</code> y <code>tests/</code> describen el detalle técnico mantenido.

Las portadas localizadas ofrecen una presentación, instalación, arquitectura y modelo de seguridad equivalentes. Cuando un detalle profundo sólo está disponible en español, enlazan a la fuente canónica en lugar de mantener una copia potencialmente obsoleta.

## Ediciones disponibles

- [Español](../../README.md)
- [日本語](./ja/README.md)
- [English](./en/README.md)

## Regla de actualización

1. Cambia primero la fuente española y verifica sus afirmaciones contra código y pruebas.
2. Actualiza las secciones equivalentes en cada portada localizada.
3. Conserva comandos, rutas, nombres de configuración y símbolos de código sin traducir.
4. No copies cifras volátiles. Enlaza a CI o a comandos reproducibles.
5. Si una traducción no puede verificarse, indícalo y enlaza a la versión española.
6. La web pública mantiene portada, guía, privacidad y términos en español, inglés y japonés con
   una plantilla compartida. El español sigue siendo la fuente canónica; las traducciones legales
   lo indican. No omitas transferencias a proveedores o limitaciones en una traducción.
7. Las fuentes de la web viven en `docs/web/content/`; genera las doce páginas con
   `node scripts/build-website.js`. El selector debe conservar la página y la sección entre idiomas.

Las ediciones coreana y portuguesa se retiraron; las variantes inglesa británica y estadounidense
se consolidaron en `en`. Sus versiones anteriores se pueden recuperar desde el historial Git.
