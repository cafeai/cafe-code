!include LogicLib.nsh
!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER
  Var CafeCodeManagedRuntimeCheckbox
  Var CafeCodeManagedRuntimeDialog
  Var CafeCodeManagedRuntimeState
!endif

!macro customInit
  StrCpy $CafeCodeManagedRuntimeState ${BST_CHECKED}
!macroend

!macro CafeCodeForceCurrentInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstallMode
  !insertmacro CafeCodeForceCurrentInstallMode
!macroend

!macro customWelcomePage
  Page custom CafeCodeManagedRuntimePageCreate CafeCodeManagedRuntimePageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function CafeCodeManagedRuntimePageCreate
  nsDialogs::Create 1018
  Pop $CafeCodeManagedRuntimeDialog
  ${If} $CafeCodeManagedRuntimeDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 32u "Cafe Code can install a managed, user-local Node/npm runtime for Codex and Claude."
  Pop $0

  ${NSD_CreateCheckbox} 0 40u 100% 14u "Enable Cafe-managed Codex and Claude runtime"
  Pop $CafeCodeManagedRuntimeCheckbox
  ${NSD_SetState} $CafeCodeManagedRuntimeCheckbox $CafeCodeManagedRuntimeState

  ${NSD_CreateLabel} 0 62u 100% 42u "When enabled, the installer copies bundled Node/npm and installs provider CLIs under %LOCALAPPDATA%\CafeCode\managed. System PATH and global npm packages are not changed."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function CafeCodeManagedRuntimePageLeave
  ${NSD_GetState} $CafeCodeManagedRuntimeCheckbox $CafeCodeManagedRuntimeState
FunctionEnd
!endif

!macro customInstall
  ${IfNot} ${isUpdated}
    ${If} $CafeCodeManagedRuntimeState == ${BST_CHECKED}
      DetailPrint "Preparing Cafe-managed Codex and Claude runtime..."
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\managed-runtime\install-managed-provider-runtime.ps1" -Enabled -InstallDir "$INSTDIR" -LocalAppData "$LOCALAPPDATA" -UserProfile "$PROFILE"'
      Pop $0
      DetailPrint "Cafe-managed runtime bootstrap exited with code $0."
    ${Else}
      DetailPrint "Cafe-managed Codex and Claude runtime disabled by installer option."
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\managed-runtime\install-managed-provider-runtime.ps1" -InstallDir "$INSTDIR" -LocalAppData "$LOCALAPPDATA" -UserProfile "$PROFILE"'
      Pop $0
    ${EndIf}
  ${EndIf}
!macroend
