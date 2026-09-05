// @ts-check
'use strict';

/** @type {Readonly<Record<string, {env: string, capabilities: Record<string, string[]>}>>} */
const CONNECTORS = Object.freeze({
  github: {
    env: 'GITHUB_CLIENT_ID',
    capabilities: {
      identity: ['read:user', 'user:email'],
      read: ['repo'],
      write: ['repo'],
    },
  },
  google: {
    env: 'GOOGLE_CLIENT_ID',
    capabilities: {
      identity: [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      calendar_read: ['https://www.googleapis.com/auth/calendar.readonly'],
      calendar_write: ['https://www.googleapis.com/auth/calendar.events'],
      mail_read: ['https://www.googleapis.com/auth/gmail.readonly'],
      mail_send: ['https://www.googleapis.com/auth/gmail.send'],
    },
  },
  microsoft: {
    env: 'MICROSOFT_CLIENT_ID',
    capabilities: {
      identity: ['User.Read'],
      calendar_read: ['Calendars.Read'],
      calendar_write: ['Calendars.ReadWrite'],
      mail_read: ['Mail.Read'],
      mail_send: ['Mail.Send'],
    },
  },
  notion: {
    env: 'NOTION_CLIENT_ID',
    capabilities: { identity: [], read: [], write: [] },
  },
});

/** @param {string} provider @param {unknown} requested */
function resolveConnectorScopes(provider, requested) {
  const connector = Object.hasOwn(CONNECTORS, provider) ? CONNECTORS[provider] : null;
  if (!connector) return null;
  const capabilities =
    Array.isArray(requested) && requested.length ? requested.map(String) : ['identity'];
  const unknown = capabilities.filter((name) => !Object.hasOwn(connector.capabilities, name));
  if (unknown.length)
    throw new Error(`Capacidades no admitidas para ${provider}: ${unknown.join(', ')}`);
  const scopes = [...new Set(capabilities.flatMap((name) => connector.capabilities[name]))];
  return {
    provider,
    capabilities,
    scopes,
    scope: scopes.join(' '),
    access:
      provider === 'notion'
        ? 'provider_configured'
        : scopes.includes('repo') || capabilities.some((name) => /write|send/.test(name))
          ? 'write'
          : 'read',
  };
}

module.exports = { CONNECTORS, resolveConnectorScopes };
