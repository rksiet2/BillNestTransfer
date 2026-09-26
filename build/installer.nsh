; Custom NSIS install steps for BillNest — adds a second "BillNest Reset"
; shortcut (Desktop + Start Menu) alongside electron-builder's normal
; "BillNest" shortcut, both pointing at the same installed .exe but the
; second one passes --factory-reset so it launches the standalone Factory
; Reset tool (electron/factoryReset.cjs) instead of the normal app.
!macro customInstall
  CreateShortCut "$DESKTOP\BillNest Reset.lnk" "$INSTDIR\BillNest.exe" "--factory-reset" "$INSTDIR\resources\build\icon-reset.ico"
  CreateDirectory "$SMPROGRAMS\BillNest"
  CreateShortCut "$SMPROGRAMS\BillNest\BillNest Reset.lnk" "$INSTDIR\BillNest.exe" "--factory-reset" "$INSTDIR\resources\build\icon-reset.ico"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\BillNest Reset.lnk"
  Delete "$SMPROGRAMS\BillNest\BillNest Reset.lnk"
!macroend
