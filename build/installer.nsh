!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\asistente.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --workspace $\"%CD%$\" %*$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\asistente.cmd"
!macroend
