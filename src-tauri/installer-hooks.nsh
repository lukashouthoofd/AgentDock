!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\AgentDock.lnk" "$INSTDIR\agentdock.exe" "" "$INSTDIR\agentdock.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\AgentDock.lnk"
!macroend
