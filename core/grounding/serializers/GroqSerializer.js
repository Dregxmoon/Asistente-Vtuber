/**
 * GroqSerializer.js — Fase 2
 *
 * Formatea el Context Package para Groq (Llama 3.3 70B).
 * Llama responde mejor con secciones markdown claras y sin XML.
 * Prioriza brevedad y estructura flat.
 */

class GroqSerializer {
  /**
   * @param {object} contextPackage — construido por ContextAssembler
   * @returns {{ systemPrompt: string, messages: Array }}
   */
  serialize(contextPackage) {
    const {
      identity,
      osContext,
      persistentMemory,
      sessionHistory,
      currentMessage,
    } = contextPackage;

    const sections = [];

    // 1. Identidad
    sections.push(this._serializeIdentity(identity));

    // 2. Contexto OS (compacto)
    if (osContext) {
      sections.push(this._serializeOS(osContext));
    }

    // 3. Memoria persistente (compacta)
    if (persistentMemory?.nodes?.length || persistentMemory?.episodes?.length) {
      sections.push(this._serializeMemory(persistentMemory));
    }

    // 4. Historial de sesión
    if (sessionHistory?.length) {
      sections.push(this._serializeSession(sessionHistory));
    }

    // 5. Instrucción final
    sections.push(this._instruction());

    const systemPrompt = sections.filter(Boolean).join('\n\n');
    const messages     = currentMessage ? [currentMessage] : [];

    return { systemPrompt, messages };
  }

  _serializeIdentity(identity) {
    if (!identity) return '';
    const lines = [];
    lines.push('# QUIÉN SOY');
    lines.push(identity.core);
    if (identity.character?.summary) {
      lines.push('');
      lines.push('## CARÁCTER');
      lines.push(identity.character.summary);
      if (identity.character.traits?.length) {
        identity.character.traits.forEach(t => lines.push(`- ${t}`));
      }
    }
    if (identity.voice?.style) {
      lines.push('');
      lines.push('## VOZ');
      lines.push(identity.voice.style);
      if (identity.voice.forbidden_phrases?.length) {
        lines.push(`Nunca uso: ${identity.voice.forbidden_phrases.join(' | ')}`);
      }
    }
    if (identity.uncertainty_behaviors) {
      const ub = identity.uncertainty_behaviors;
      lines.push('');
      lines.push('## CUANDO NO SÉ ALGO');
      lines.push(`Sin saber: ${ub.doesnt_know?.description}`);
      lines.push(`Insegura: ${ub.is_unsure?.description}`);
      lines.push(`Equivocada: ${ub.was_wrong?.description}`);
    }
    if (identity.limits?.what_i_am_not?.length) {
      lines.push('');
      lines.push('## LO QUE NO SOY');
      identity.limits.what_i_am_not.forEach(l => lines.push(`- ${l}`));
    }
    return lines.join('\n');
  }

  _serializeOS(osContext) {
    const lines = ['# CONTEXTO ACTUAL'];
    lines.push(osContext.timeFormatted);

    if (osContext.app) {
      const appLine = osContext.elapsed > 60
        ? `Lleva ${osContext.elapsedFormatted} en ${osContext.friendlyName || osContext.app}.`
        : `Tiene ${osContext.friendlyName || osContext.app} abierto.`;
      lines.push(appLine);

      if (osContext.title && osContext.title.length > 2) {
        lines.push(`Ventana: "${osContext.title.slice(0, 80)}"`);
      }
    }

    if (osContext.todaySummary) {
      lines.push(`Hoy ha usado: ${osContext.todaySummary}`);
    }

    if (osContext.openWindowsSummary) {
      lines.push(`Ventanas abiertas ahora: ${osContext.openWindowsSummary}`);
    }

    return lines.join('\n');
  }

  _serializeMemory(mem) {
    const lines = [];

    const { nodes = [], episodes = [] } = mem;

    const users    = nodes.filter(n => n.type === 'User');
    const projects = nodes.filter(n => n.type === 'Project');
    const prefs    = nodes.filter(n => n.type === 'Preference');
    const beliefs  = nodes.filter(n => n.type === 'Belief');

    if (users.length) {
      lines.push('# LO QUE SÉ DEL USUARIO');
      users.forEach(n => lines.push(`- ${n.content}`));
    }
    if (projects.length) {
      lines.push('# PROYECTOS ACTIVOS');
      projects.forEach(n => lines.push(`- ${n.content}`));
    }
    if (prefs.length) {
      lines.push('# PREFERENCIAS');
      prefs.forEach(n => lines.push(`- ${n.content}`));
    }
    if (beliefs.length) {
      lines.push('# OBSERVACIONES');
      beliefs.forEach(n => lines.push(`- ${n.content}`));
    }
    if (episodes.length) {
      lines.push('# SESIONES ANTERIORES');
      episodes.forEach(e => lines.push(`- ${e.content.slice(0, 180)}`));
    }

    return lines.join('\n');
  }

  _serializeSession(history) {
    const lines = ['# CONVERSACIÓN ACTUAL'];
    history.slice(-8).forEach(msg => {
      const role = msg.role === 'user' ? 'Usuario' : 'March';
      lines.push(`${role}: ${msg.content}`);
    });
    return lines.join('\n');
  }

  _instruction() {
    return [
      '# INSTRUCCIÓN',
      'Responde como March 7th. Sé concisa cuando el momento lo pide, más extensa cuando el tema lo merece.',
      'No uses las frases prohibidas. No te presentes en cada mensaje.',
      'Si tienes contexto del OS, úsalo naturalmente sin anunciarlo.',
      'Si tienes memoria de sesiones anteriores, úsala de forma natural.',
      'Responde en el idioma en que te hablen.',
    ].join('\n');
  }
}

module.exports = { GroqSerializer };