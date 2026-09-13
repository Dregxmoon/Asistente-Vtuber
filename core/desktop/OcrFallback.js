// @ts-check
'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');

/**
 * OcrFallback.js — ojos de respaldo cuando AT-SPI no ve nada (Wayland,
 * canvas, juegos, PDFs escaneados). Lee texto de una captura con Tesseract
 * (binario del sistema, sin dependencias nuevas) y convierte coincidencias
 * en puntos de pantalla usando la misma geometría que pointer_click.
 *
 * Cadena completa sin accesibilidad: desktop_screenshot → ocr_query →
 * pointer_click → volver a observar. Nunca inventa coordenadas: todo punto
 * sale de cajas TSV reales con confianza.
 */

const { spawn } = require('child_process');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LANG = 'eng';

/** @param {unknown} value @param {number} [max] */
function _safeText(value, max = 200) {
  return String(value || '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, max);
}

/** @param {unknown} value */
function _normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Ejecuta tesseract sobre un buffer de imagen y devuelve filas TSV.
 * @param {Buffer} image JPEG/PNG
 * @param {string} lang p.ej. 'eng', 'spa' (debe estar instalado en tessdata)
 * @param {(command: string, args: string[], options: object) => import('child_process').ChildProcess} [spawnImpl]
 * @returns {Promise<Array<{text: string, confidence: number, left: number, top: number, width: number, height: number}>>}
 */
function readWords(image, lang = DEFAULT_LANG, spawnImpl = spawn) {
  const language = /^[a-z]{3}([+][a-z]{3})?$/.test(String(lang || ''))
    ? String(lang)
    : DEFAULT_LANG;
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > MAX_IMAGE_BYTES) {
    return Promise.reject(new Error('Imagen inválida para OCR'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('tesseract', ['stdin', 'stdout', '-l', language, '--psm', '6', 'tsv'], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      try {
        child.kill();
      } catch (_) {
        swallow('OcrFallback.readWords');
      }
      reject(new Error('Tesseract no expuso canales seguros (¿está instalado?)'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @param {Error|null} error @param {Array<{text: string, confidence: number, left: number, top: number, width: number, height: number}>|null} [words] */
    const done = (error, words) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(words || []);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        swallow('OcrFallback.done');
      }
      done(new Error('Tesseract agotó el tiempo (¿imagen demasiado grande?)'));
    }, 30_000);
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      done(
        new Error(
          /ENOENT/.test(message)
            ? 'Tesseract no está instalado (Linux: tu gestor de paquetes; Windows: UB Mannheim build)'
            : message
        )
      );
    });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 2 * 1024 * 1024) {
        try {
          child.kill();
        } catch (_) {
          swallow('OcrFallback.done');
        }
        done(new Error('Salida OCR excesiva'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('close', (code) => {
      if (code !== 0) {
        const hint = /Failed loading language|Error opening data file/i.test(stderr)
          ? ` (idioma '${language}' no instalado en tessdata)`
          : '';
        done(
          new Error(
            `Tesseract terminó con código ${String(code)}${hint}: ${stderr.trim().slice(0, 200)}`
          )
        );
        return;
      }
      try {
        done(null, _parseTsv(stdout));
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      child.stdin.write(image);
      child.stdin.end();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Parsea TSV de tesseract (nivel palabra, conf >= 0).
 * @param {string} tsv
 */
function _parseTsv(tsv) {
  const lines = String(tsv || '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  /** @param {string} name @returns {number} */
  const idx = (name) => header.indexOf(name);
  const [level, text, conf, left, top, width, height] = [
    idx('level'),
    idx('text'),
    idx('conf'),
    idx('left'),
    idx('top'),
    idx('width'),
    idx('height'),
  ];
  if ([level, text, conf, left, top, width, height].some((i) => i < 0)) {
    throw new Error('TSV de Tesseract con formato inesperado');
  }
  const words = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (Number(cols[level]) !== 5) continue;
    const confidence = Number(cols[conf]);
    if (!Number.isFinite(confidence) || confidence < 0) continue;
    const word = _safeText(cols[text], 120);
    if (!word) continue;
    words.push({
      text: word,
      confidence,
      left: Number(cols[left]) || 0,
      top: Number(cols[top]) || 0,
      width: Number(cols[width]) || 0,
      height: Number(cols[height]) || 0,
    });
  }
  return words;
}

/**
 * Busca una consulta en las palabras OCR y devuelve puntos de pantalla.
 * @param {Array<{text: string, confidence: number, left: number, top: number, width: number, height: number}>} words
 * @param {unknown} query texto a localizar ("Buscar", "Aceptar")
 * @param {{bounds: {x: number, y: number, width: number, height: number}, imageSize: {width: number, height: number}}} geometry misma geometría de la captura
 * @param {number} [minConfidence]
 */
function locateQuery(words, query, geometry, minConfidence = 30) {
  const needle = _normalize(query);
  if (!needle) throw new Error('ocr_query requiere un texto a localizar');
  const terms = needle.split(/\s+/).filter(Boolean);
  const matches = [];
  for (const word of Array.isArray(words) ? words : []) {
    if (word.confidence < minConfidence) continue;
    const haystack = _normalize(word.text);
    if (!terms.every((term) => haystack.includes(term))) continue;
    const centerX = word.left + word.width / 2;
    const centerY = word.top + word.height / 2;
    const screenX = Math.round(
      geometry.bounds.x + (centerX / geometry.imageSize.width) * geometry.bounds.width
    );
    const screenY = Math.round(
      geometry.bounds.y + (centerY / geometry.imageSize.height) * geometry.bounds.height
    );
    matches.push({
      text: word.text,
      confidence: word.confidence,
      screenPoint: { x: screenX, y: screenY },
    });
  }
  matches.sort((a, b) => b.confidence - a.confidence);
  return matches.slice(0, 10);
}

module.exports = { readWords, locateQuery, DEFAULT_LANG, MAX_IMAGE_BYTES };
