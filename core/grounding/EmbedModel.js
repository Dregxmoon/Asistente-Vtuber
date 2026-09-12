// @ts-check
'use strict';

/**
 * EmbedModel.js — UNA sola fuente de verdad para el modelo de embeddings.
 *
 * Todo el pipeline semántico (IntentDetector, skills, memoria, init_vectors)
 * usa este modelo. Multilingüe por diseño: la cobertura de idiomas la dan las
 * pesas, no hay ramas por idioma en el código.
 *
 * paraphrase-multilingual-MiniLM-L12-v2: 384 dims (igual que el anterior
 * all-MiniLM-L6-v2 → el esquema sqlite-vec NO cambia), ~120MB, CPU.
 */
const EMBED_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const EMBED_DIMS = 384;

module.exports = { EMBED_MODEL_ID, EMBED_DIMS };
