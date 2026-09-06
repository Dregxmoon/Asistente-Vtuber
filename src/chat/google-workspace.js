// @ts-nocheck
'use strict';
// Wizard de cuenta local: el renderer nunca recibe secretos guardados ni tokens.
(() => {
  const services = {
    calendar: 'Calendar',
    gmail: 'Gmail',
    drive: 'Drive',
    docs: 'Docs',
    sheets: 'Sheets',
    tasks: 'Tasks',
    contacts: 'Contacts',
  };
  const apis = {
    calendar: 'Google Calendar API',
    gmail: 'Gmail API',
    drive: 'Google Drive API',
    docs: 'Google Docs API y Google Drive API',
    sheets: 'Google Sheets API y Google Drive API',
    tasks: 'Google Tasks API',
    contacts: 'People API',
  };
  document.getElementById('mcp-google-workspace-btn')?.addEventListener('click', async () => {
    const view = document.getElementById('mcp-auth-view');
    document.getElementById('mcp-store-view').style.display = 'none';
    document.getElementById('mcp-installed-view').style.display = 'none';
    view.style.display = 'block';
    view.innerHTML = `<form id="google-workspace-form" class="mcp-auth-flow">
      <h2>Conectar Google Workspace</h2>
      <fieldset><legend>A · Prepara tu cuenta</legend>
        <p>Conecta tu propia cuenta de Google para que Kaoru utilice los servicios que elijas.</p>
        <button type="button" id="google-cloud-console">Abrir Google Cloud Console</button>
        <details><summary>Instrucciones para obtener tus credenciales</summary>
          <ol><li>Crea un proyecto para Kaoru.</li><li>En APIs y servicios → Biblioteca, habilita: <span id="google-required-apis">Google Calendar API</span>.</li>
          <li>Configura Google Auth Platform: audiencia Externa y tu cuenta como usuario de prueba.</li>
          <li>En Clientes, crea un cliente de tipo Aplicación de escritorio. Copia su Client ID y Client Secret.</li></ol>
        </details>
      </fieldset>
      <fieldset><legend>B · Servicios</legend>${Object.entries(services)
        .map(
          ([key, label]) =>
            `<label style="display:inline-block;margin:8px"><input type="checkbox" name="service" value="${key}" ${key === 'calendar' ? 'checked' : ''}> ${label}</label>`
        )
        .join('')}</fieldset>
      <fieldset><legend>C · Acceso</legend><label><input type="checkbox" id="google-read-only" checked> Solo lectura</label><p>Desactívalo si quieres permitir acciones como crear eventos o enviar correos.</p></fieldset>
      <fieldset><legend>D · Credenciales de tu aplicación</legend>
        <label for="google-client-id">Client ID</label><input id="google-client-id" type="text" required autocomplete="off" pattern="[A-Za-z0-9_\\x2d]+\\.apps\\.googleusercontent\\.com" placeholder="…apps.googleusercontent.com" style="display:block;width:100%">
        <label for="google-client-secret">Client Secret</label><input id="google-client-secret" type="password" required minlength="8" maxlength="512" autocomplete="new-password" style="display:block;width:100%">
        <p>Kaoru intentará guardar el secreto en el llavero del sistema.</p>
      </fieldset>
      <details><summary>Opciones avanzadas</summary><label for="google-uvx-path">Ruta de uvx (se detecta automáticamente)</label><input id="google-uvx-path" type="text" style="display:block;width:100%"><p>Si no tienes uv instalado, instálalo siguiendo <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noopener noreferrer">su guía</a>.</p></details>
      <p id="google-workspace-status" role="status" aria-live="polite"></p>
      <button type="button" id="google-workspace-back">Volver</button>
      <button type="submit" class="btn-save" id="google-workspace-save">Guardar y conectar</button>
    </form>`;
    const form = document.getElementById('google-workspace-form');
    const status = document.getElementById('google-workspace-status');
    document.getElementById('google-workspace-back').onclick = () =>
      document.getElementById('mcp-tab-installed').click();
    document.getElementById('google-cloud-console').onclick = async () => {
      try {
        await window.assistant.invoke('mcp-google-workspace-console');
      } catch (_) {
        status.textContent = 'No se pudo abrir el navegador.';
      }
    };
    form.addEventListener('change', () => {
      document.getElementById('google-required-apis').textContent =
        [...form.querySelectorAll('[name="service"]:checked')]
          .map((input) => apis[input.value])
          .join(', ') || 'Selecciona al menos un servicio';
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const selected = [...form.querySelectorAll('[name="service"]:checked')].map(
        (input) => input.value
      );
      const clientId = document.getElementById('google-client-id').value.trim();
      const clientSecret = document.getElementById('google-client-secret').value.trim();
      if (!selected.length) {
        status.textContent = 'Selecciona al menos un servicio.';
        return;
      }
      if (
        !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
        !/^[\x21-\x7e]{8,512}$/.test(clientSecret)
      ) {
        status.textContent = 'Revisa el Client ID y el Client Secret.';
        return;
      }
      const button = document.getElementById('google-workspace-save');
      button.disabled = true;
      status.textContent =
        'Preparando Google Workspace… La primera vez puede tardar mientras se descarga el conector.';
      try {
        const response = await window.assistant.invoke('mcp-google-workspace-connect', {
          clientId,
          clientSecret,
          services: selected,
          readOnly: document.getElementById('google-read-only').checked,
          uvxPath: document.getElementById('google-uvx-path').value.trim(),
        });
        if (!response.ok) throw new Error(response.error);
        document.getElementById('google-client-secret').value = '';
        status.textContent =
          response.status?.status === 'connected'
            ? 'Conector listo. Pide a Kaoru que consulte tu calendario usando google-workspace y completa la autorización de Google cuando te muestre el enlace. Tu correo se recordará automáticamente al confirmar la cuenta.'
            : `Configuración guardada. No se pudo conectar: ${response.status?.error || 'reintenta la conexión'}`;
        if (response.authStarted)
          status.textContent =
            'Completa la autorización en el navegador. Después pide a Kaoru que consulte el servicio elegido usando google-workspace; tu correo se guardará al confirmar la sesión.';
        if (response.authError) status.textContent = response.authError;
        if (response.credentialStorage === 'plaintext')
          status.textContent +=
            ' El llavero y el cifrado no están disponibles: el secreto quedó guardado en texto plano en la configuración local.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    try {
      const info = await window.assistant.invoke('mcp-google-workspace-info');
      if (!form.isConnected) return;
      document.getElementById('google-uvx-path').value = info.uvxPath || '';
      if (info.configured)
        status.textContent = info.email
          ? `Cuenta guardada: ${info.email}. Guardar actualizará esta conexión.`
          : 'Guardar actualizará la conexión Google Workspace existente.';
    } catch (_) {
      status.textContent = 'No se pudo detectar uvx; puedes indicar su ruta en Opciones avanzadas.';
    }
  });
})();
