!ifndef BUILD_UNINSTALLER
  !include "MUI2.nsh"
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  Var MdmBrowserDialog
  Var MdmBrowserChromeRadio
  Var MdmBrowserEdgeRadio
  Var MdmBrowserFirefoxRadio
  Var MdmBrowserLaterRadio
  Var MdmBrowserChoice
  Var MdmChromePath
  Var MdmEdgePath
  Var MdmFirefoxPath
  Var MdmBrowserPath
  Var MdmBrowserUrl
  Var MdmInstructionLabel
  Var MdmInstructionText

  Function MdmFindChrome
    StrCpy $MdmChromePath ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmChromePath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmChromePath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      StrCpy $MdmChromePath "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      Return
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
      StrCpy $MdmChromePath "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
      Return
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES\Google\Chrome\Application\chrome.exe"
      StrCpy $MdmChromePath "$PROGRAMFILES\Google\Chrome\Application\chrome.exe"
    ${EndIf}
  FunctionEnd

  Function MdmFindEdge
    StrCpy $MdmEdgePath ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmEdgePath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmEdgePath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe"
      StrCpy $MdmEdgePath "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe"
      Return
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES\Microsoft\Edge\Application\msedge.exe"
      StrCpy $MdmEdgePath "$PROGRAMFILES\Microsoft\Edge\Application\msedge.exe"
    ${EndIf}
  FunctionEnd

  Function MdmFindFirefox
    StrCpy $MdmFirefoxPath ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmFirefoxPath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" ""
    ${If} $0 != ""
      ${If} ${FileExists} "$0"
        StrCpy $MdmFirefoxPath "$0"
        Return
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES64\Mozilla Firefox\firefox.exe"
      StrCpy $MdmFirefoxPath "$PROGRAMFILES64\Mozilla Firefox\firefox.exe"
      Return
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES\Mozilla Firefox\firefox.exe"
      StrCpy $MdmFirefoxPath "$PROGRAMFILES\Mozilla Firefox\firefox.exe"
    ${EndIf}
  FunctionEnd

  Function MdmUpdateBrowserInstructions
    ${If} $MdmBrowserChoice == "1"
      ${If} $MdmChromePath == ""
        StrCpy $MdmInstructionText "Chrome was not detected. You can choose another browser or install the extension later from MDM > Browser."
      ${Else}
        StrCpy $MdmInstructionText "After installation:$\r$\n1. Chrome opens at chrome://extensions.$\r$\n2. Turn on Developer mode (top-right).$\r$\n3. Click Load unpacked and paste the copied path, or select the extension folder inside resources.$\r$\n4. Pin MDM and click its icon; pairing and the token are automatic."
      ${EndIf}
    ${ElseIf} $MdmBrowserChoice == "2"
      ${If} $MdmEdgePath == ""
        StrCpy $MdmInstructionText "Edge was not detected. You can choose another browser or install the extension later from MDM > Browser."
      ${Else}
        StrCpy $MdmInstructionText "After installation:$\r$\n1. Edge opens at edge://extensions.$\r$\n2. Turn on Developer mode (top-right).$\r$\n3. Click Load unpacked and paste the copied path, or select the extension folder inside resources.$\r$\n4. Pin MDM and click its icon; pairing and the token are automatic."
      ${EndIf}
    ${ElseIf} $MdmBrowserChoice == "3"
      ${If} $MdmFirefoxPath == ""
        StrCpy $MdmInstructionText "Firefox was not detected. You can choose another browser or install the extension later from MDM > Browser."
      ${Else}
        StrCpy $MdmInstructionText "After installation:$\r$\n1. Firefox opens at about:debugging#/runtime/this-firefox.$\r$\n2. Click Load Temporary Add-on.$\r$\n3. Select firefox\manifest.json inside the extension folder.$\r$\n4. Pairing and the token are automatic. Reload the add-on after Firefox restarts."
      ${EndIf}
    ${Else}
      StrCpy $MdmInstructionText "No browser will open. Install later from MDM > Browser. A setup guide and the extension folder path are saved in the MDM installation folder."
    ${EndIf}
    ${NSD_SetText} $MdmInstructionLabel $MdmInstructionText
  FunctionEnd

  Function MdmBrowserChanged
    ${NSD_GetState} $MdmBrowserChromeRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $MdmBrowserChoice "1"
    ${Else}
      ${NSD_GetState} $MdmBrowserEdgeRadio $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $MdmBrowserChoice "2"
      ${Else}
        ${NSD_GetState} $MdmBrowserFirefoxRadio $0
        ${If} $0 == ${BST_CHECKED}
          StrCpy $MdmBrowserChoice "3"
        ${Else}
          StrCpy $MdmBrowserChoice "4"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Call MdmUpdateBrowserInstructions
  FunctionEnd

  Function MdmBrowserPageCreate
    !insertmacro MUI_HEADER_TEXT "Browser extension" "Choose a browser for the MDM extension."
    ${If} ${Silent}
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $MdmBrowserDialog
    ${If} $MdmBrowserDialog == error
      Abort
    ${EndIf}

    Call MdmFindChrome
    Call MdmFindEdge
    Call MdmFindFirefox

    ${NSD_CreateLabel} 0 0 100% 12u "Extension folder: resources\extension"
    Pop $0
    ${NSD_CreateLabel} 0 12u 100% 10u "The full path is copied to your clipboard."
    Pop $0

    ${NSD_CreateRadioButton} 0 24u 100% 12u "Google Chrome"
    Pop $MdmBrowserChromeRadio
    ${NSD_CreateRadioButton} 0 37u 100% 12u "Microsoft Edge"
    Pop $MdmBrowserEdgeRadio
    ${NSD_CreateRadioButton} 0 50u 100% 12u "Mozilla Firefox"
    Pop $MdmBrowserFirefoxRadio
    ${NSD_CreateRadioButton} 0 63u 100% 12u "Install the extension later"
    Pop $MdmBrowserLaterRadio

    ${If} $MdmChromePath != ""
      ${NSD_SetText} $MdmBrowserChromeRadio "Google Chrome (installed)"
    ${Else}
      ${NSD_SetText} $MdmBrowserChromeRadio "Google Chrome (not detected)"
    ${EndIf}
    ${If} $MdmEdgePath != ""
      ${NSD_SetText} $MdmBrowserEdgeRadio "Microsoft Edge (installed)"
    ${Else}
      ${NSD_SetText} $MdmBrowserEdgeRadio "Microsoft Edge (not detected)"
    ${EndIf}
    ${If} $MdmFirefoxPath != ""
      ${NSD_SetText} $MdmBrowserFirefoxRadio "Mozilla Firefox (installed)"
    ${Else}
      ${NSD_SetText} $MdmBrowserFirefoxRadio "Mozilla Firefox (not detected)"
    ${EndIf}

    ${NSD_CreateLabel} 0 78u 100% 60u ""
    Pop $MdmInstructionLabel

    ${If} $MdmChromePath != ""
      StrCpy $MdmBrowserChoice "1"
      ${NSD_Check} $MdmBrowserChromeRadio
    ${ElseIf} $MdmEdgePath != ""
      StrCpy $MdmBrowserChoice "2"
      ${NSD_Check} $MdmBrowserEdgeRadio
    ${ElseIf} $MdmFirefoxPath != ""
      StrCpy $MdmBrowserChoice "3"
      ${NSD_Check} $MdmBrowserFirefoxRadio
    ${Else}
      StrCpy $MdmBrowserChoice "4"
      ${NSD_Check} $MdmBrowserLaterRadio
    ${EndIf}
    Call MdmUpdateBrowserInstructions

    ${NSD_OnClick} $MdmBrowserChromeRadio MdmBrowserChanged
    ${NSD_OnClick} $MdmBrowserEdgeRadio MdmBrowserChanged
    ${NSD_OnClick} $MdmBrowserFirefoxRadio MdmBrowserChanged
    ${NSD_OnClick} $MdmBrowserLaterRadio MdmBrowserChanged

    nsDialogs::Show
  FunctionEnd

  Function MdmBrowserPageLeave
    StrCpy $MdmBrowserPath ""
    StrCpy $MdmBrowserUrl ""
    ${NSD_GetState} $MdmBrowserChromeRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $MdmBrowserChoice "1"
    ${Else}
      ${NSD_GetState} $MdmBrowserEdgeRadio $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $MdmBrowserChoice "2"
      ${Else}
        ${NSD_GetState} $MdmBrowserFirefoxRadio $0
        ${If} $0 == ${BST_CHECKED}
          StrCpy $MdmBrowserChoice "3"
        ${Else}
          StrCpy $MdmBrowserChoice "4"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ${If} $MdmBrowserChoice == "1"
      ${If} $MdmChromePath != ""
        StrCpy $MdmBrowserPath "$MdmChromePath"
        StrCpy $MdmBrowserUrl "chrome://extensions/"
      ${Else}
        MessageBox MB_ICONINFORMATION|MB_OK "Google Chrome was not detected. You can install the extension later from MDM > Browser."
      ${EndIf}
    ${ElseIf} $MdmBrowserChoice == "2"
      ${If} $MdmEdgePath != ""
        StrCpy $MdmBrowserPath "$MdmEdgePath"
        StrCpy $MdmBrowserUrl "edge://extensions/"
      ${Else}
        MessageBox MB_ICONINFORMATION|MB_OK "Microsoft Edge was not detected. You can install the extension later from MDM > Browser."
      ${EndIf}
    ${ElseIf} $MdmBrowserChoice == "3"
      ${If} $MdmFirefoxPath != ""
        StrCpy $MdmBrowserPath "$MdmFirefoxPath"
        StrCpy $MdmBrowserUrl "about:debugging#/runtime/this-firefox"
      ${Else}
        MessageBox MB_ICONINFORMATION|MB_OK "Mozilla Firefox was not detected. You can install the extension later from MDM > Browser."
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !macro customInstall
    FileOpen $0 "$INSTDIR\Browser extension setup.txt" w
    FileWrite $0 "MDM browser extension setup$\r$\n"
    FileWrite $0 "==========================$\r$\n$\r$\n"
    FileWrite $0 "Extension folder for Chrome and Edge:$\r$\n$INSTDIR\resources\extension$\r$\n$\r$\n"
    FileWrite $0 "Firefox manifest:$\r$\n$INSTDIR\resources\extension\firefox\manifest.json$\r$\n$\r$\n"
    FileWrite $0 "Chrome:$\r$\n1. Open chrome://extensions$\r$\n2. Turn on Developer mode in the top-right corner.$\r$\n3. Click Load unpacked and select the extension folder above.$\r$\n4. Pin MDM and click its icon. It pairs automatically.$\r$\n$\r$\n"
    FileWrite $0 "Edge:$\r$\n1. Open edge://extensions$\r$\n2. Turn on Developer mode in the top-right corner.$\r$\n3. Click Load unpacked and select the extension folder above.$\r$\n4. Pin MDM and click its icon. It pairs automatically.$\r$\n$\r$\n"
    FileWrite $0 "Firefox:$\r$\n1. Open about:debugging#/runtime/this-firefox$\r$\n2. Click Load Temporary Add-on.$\r$\n3. Select the Firefox manifest above.$\r$\n4. Pairing is automatic. Reload the add-on after Firefox restarts.$\r$\n$\r$\n"
    FileWrite $0 "You can repeat these steps at any time from MDM > Browser.$\r$\n"
    FileWrite $0 "The extension folder path is copied to your clipboard after installation.$\r$\n"
    FileClose $0

    FileOpen $0 "$PLUGINSDIR\mdm-extension-path.txt" w
    FileWrite $0 "$INSTDIR\resources\extension"
    FileClose $0
  !macroend

  !macro customFinishPage
    Page custom MdmBrowserPageCreate MdmBrowserPageLeave
    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      ${If} $MdmBrowserPath != ""
        nsExec::ExecToStack 'cmd.exe /C type "$PLUGINSDIR\mdm-extension-path.txt"|"$SYSDIR\clip.exe"'
        Pop $0
        Pop $0
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\resources" "open" ""
        ${StdUtils.ExecShellAsUser} $0 "$MdmBrowserPath" "open" "$MdmBrowserUrl"
        StrCpy $MdmBrowserPath ""
      ${EndIf}
    FunctionEnd
    !define MUI_FINISHPAGE_TEXT "MDM is installed.$\r$\n$\r$\nClick Finish to launch MDM and open the browser extension setup. The extension path is on your clipboard. Follow the numbered steps from the previous page: enable Developer mode, choose Load unpacked, paste the path, then pin and open MDM. Pairing is automatic.$\r$\nA setup guide is saved as 'Browser extension setup.txt' in the MDM installation folder."
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif
