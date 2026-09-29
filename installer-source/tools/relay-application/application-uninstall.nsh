!macro customUnInstall
  # Replacing the outer package is not a request to disconnect Relay.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\node.exe" "$INSTDIR\resources\activate.cjs" uninstall-package "$INSTDIR" "$INSTDIR\relay.exe"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Relay could not finish removing its agent connections and background services. Your account data is preserved. Open Relay and retry removal before deleting the application." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend
