/**
 * GeminiSerializer.js — Fase 2
 *
 * Formatea el Context Package para Gemini 2.0 Flash.
 * Gemini responde mejor con instrucciones más explícitas y separadas.
 * El system_instruction va separado del historial de mensajes.
 */

const { GroqSerializer } = require('./GroqSerializer.js');

class GeminiSerializer extends GroqSerializer {
  /**
   * Gemini usa el mismo format de systemPrompt que Groq.
   * La diferencia real está en cómo LLMProvider envía la petición
   * (system_instruction separado). El serializer solo ajusta el tono.
   *
   * _serializeOS (con openWindowsSummary) se hereda automáticamente de GroqSerializer.
   */
  serialize(contextPackage) {
    // Reutilizamos la lógica de Groq — el formato de system prompt es compatible
    const result = super.serialize(contextPackage);

    // Gemini prefiere instrucciones más explícitas al final
    result.systemPrompt = result.systemPrompt.replace(
      '# INSTRUCCIÓN',
      '# INSTRUCCIONES PARA ESTA RESPUESTA'
    );

    return result;
  }
}

/**
 * OpenAISerializer.js — Fase 2
 *
 * Formatea el Context Package para GPT-4o-mini.
 * GPT responde bien con el formato estándar de mensajes de OpenAI.
 * Misma estructura que Groq pero con límites de tokens más conservadores.
 *
 * _serializeOS (con openWindowsSummary) se hereda automáticamente de GroqSerializer.
 */
class OpenAISerializer extends GroqSerializer {
  serialize(contextPackage) {
    const result = super.serialize(contextPackage);
    // GPT-4o-mini tiene buen seguimiento de instrucciones con el mismo formato
    // Solo ajustamos el límite implícito de la memoria serializada
    return result;
  }
}

module.exports = { GeminiSerializer, OpenAISerializer };