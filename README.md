# 🎭 VTuber Overlay — March 7th

Overlay de escritorio para Windows que muestra el modelo Live2D de March 7th 
flotando sobre cualquier aplicación, juego o navegador.

## ✅ Requisitos

- Windows 10/11 (64 bits)
- [Node.js](https://nodejs.org) v18 o superior (LTS recomendado)

## 🚀 Instalación

1. Clona el repositorio:
   git clone https://github.com/TU_USUARIO/TU_REPO.git

2. Entra a la carpeta:
   cd vtuber-overlay

3. Instala las dependencias:
   npm install

4. Si Electron falla al instalar, ejecuta:
   [System.IO.File]::WriteAllText("$PWD\node_modules\electron\path.txt", "electron.exe")

5. Inicia el overlay:
   npm start

## ⚠️ Solución al error de Electron (Windows)

Si al hacer npm start aparece:
"Electron failed to install correctly"

Ejecuta esto en PowerShell dentro de la carpeta del proyecto:

   [System.IO.File]::WriteAllText("$PWD\node_modules\electron\path.txt", "electron.exe")

Luego vuelve a ejecutar npm start.
