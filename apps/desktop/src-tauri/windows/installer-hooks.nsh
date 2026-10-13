; Tauri's .onInit also calls MUI_LANGDLL_DISPLAY in passive updater mode.
; Keep Modern UI's saved-language/default-language behavior, but skip its dialog
; for /P, /UPDATE and /S. Check the command line directly because un.onInit calls
; MUI_UNGETLANGUAGE before Tauri has populated PassiveMode and UpdateMode.
!macroundef MUI_LANGDLL_DISPLAY
!macro MUI_LANGDLL_DISPLAY
  !verbose push
  !verbose ${MUI_VERBOSE}
  !insertmacro MUI_LANGDLL_VARIABLES
  !insertmacro MUI_DEFAULT MUI_LANGDLL_WINDOWTITLE "Installer Language"
  !insertmacro MUI_DEFAULT MUI_LANGDLL_INFO "Please select a language."

  !ifdef MUI_LANGDLL_REGISTRY_VARIABLES
    ReadRegStr $mui.LangDLL.RegistryLanguage "${MUI_LANGDLL_REGISTRY_ROOT}" "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
    ${If} $mui.LangDLL.RegistryLanguage != ""
      StrCpy $LANGUAGE $mui.LangDLL.RegistryLanguage
    ${EndIf}
  !endif

  Push $R0
  ${Unless} ${Silent}
    ClearErrors
    ${GetOptions} $CMDLINE "/P" $R0
    ${If} ${Errors}
      ClearErrors
      ${GetOptions} $CMDLINE "/UPDATE" $R0
      ${If} ${Errors}
        !ifndef MUI_LANGDLL_ALWAYSSHOW
          !ifdef MUI_LANGDLL_REGISTRY_VARIABLES
            ${If} $mui.LangDLL.RegistryLanguage == ""
          !endif
        !endif

        !ifdef MUI_LANGDLL_ALLLANGUAGES
          LangDLL::LangDialog "${MUI_LANGDLL_WINDOWTITLE}" "${MUI_LANGDLL_INFO}" A ${MUI_LANGDLL_LANGUAGES} ""
        !else
          LangDLL::LangDialog "${MUI_LANGDLL_WINDOWTITLE}" "${MUI_LANGDLL_INFO}" AC ${MUI_LANGDLL_LANGUAGES_CP} ""
        !endif
        Pop $LANGUAGE
        ${If} $LANGUAGE == "cancel"
          Pop $R0
          Abort
        ${EndIf}

        !ifndef MUI_LANGDLL_ALWAYSSHOW
          !ifdef MUI_LANGDLL_REGISTRY_VARIABLES
            ${EndIf}
          !endif
        !endif
      ${EndIf}
    ${EndIf}
  ${EndUnless}
  Pop $R0
  ClearErrors
  !verbose pop
!macroend
