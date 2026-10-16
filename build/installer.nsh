/**
 * 自定义 NSIS 逻辑：用自绘目录页替换 electron-builder 模板的 MUI 内置目录页，
 * 让用户「浏览」自选安装目录后，路径文本框立即显示 <所选目录>\TMD。
 *
 * 为什么需要：
 * 1. 模板自带目录页浏览选择后不会把产品子目录显示在路径框里，且其追加逻
 *    辑（instFilesPre）用 StrContains 在整条路径里找 "TMD"——路径任意位
 *    置含该子串（如 D:\MyTMDTools）就不再追加，文件被平铺进所选目录；
 * 2. MUI 内置目录页没有「浏览返回后」的钩子，无法在选完文件夹时即时回
 *    写路径框，只能整页替换。
 *
 * 实现方式：build.nsis.allowToChangeInstallationDirectory 置 false 后，模
 * 板不再插入内置目录页；这里经 customPageAfterChangeDir 宏钩子（模板在
 * 安装页之前预留，本文件经 build.nsis.include 在模板之前被 include）插入
 * nsDialogs 自绘目录页，布局对齐内置页：说明文字、「目标文件夹」分组框
 * （内嵌路径框 + 浏览按钮）、所需空间/可用空间两行信息。浏览按钮回调里
 * 修正路径并立即回写文本框（即时显示 \TMD）并刷新可用空间；leave 回调
 * 对手工输入做同样兜底修正。tmdFixInstallDir 只比较路径最后一段，幂等。
 * 文案全部复用 NSIS/MUI 预置语言字符串，随向导语言自动切换；升级安装
 * （--updated）时按模板原行为跳过目录页。
 *
 * @author chiangyang
 */

!ifndef BUILD_UNINSTALLER
!ifndef ONE_CLICK
  !include nsDialogs.nsh
  !include FileFunc.nsh
  !insertmacro DriveSpace ; 生成 DriveSpace 函数，供 ${DriveSpace} 取磁盘可用空间

  Var tmdDirText    ; 目录页路径文本框句柄
  Var tmdSpaceReq   ; 所需空间标签句柄
  Var tmdSpaceAvail ; 可用空间标签句柄

  ; 目录修正：若 $INSTDIR 最后一段不是产品目录名则追加 \TMD
  ; （纯逻辑函数，与页面钩子分离，便于脱离向导流程独立验证）
  Function tmdFixInstallDir
    ; 先去掉末尾反斜杠（选中盘符根目录如 D:\ 时，避免拼出 D:\\TMD）
    StrCpy $0 $INSTDIR 1 -1
    StrCmp $0 "\" 0 +2
      StrCpy $INSTDIR $INSTDIR -1
    ; 仅当路径最后一段不是产品目录名时追加
    StrLen $0 "${APP_FILENAME}"
    StrCpy $1 $INSTDIR $0 -$0
    StrCmp $1 "${APP_FILENAME}" +2 0
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  FunctionEnd

  ; 容量格式化：输入 $2=KB 数，输出 $6=带单位字符串
  ; （对齐内置目录页风格：GB/MB 保留 1 位小数并四舍五入，KB 取整）
  Function tmdFormatSize
    ${If} $2 >= 1048576
      IntOp $6 $2 / 1048576
      IntOp $7 $2 % 1048576
      IntOp $7 $7 * 10
      IntOp $7 $7 + 524288
      IntOp $7 $7 / 1048576
      ${If} $7 >= 10
        IntOp $6 $6 + 1
        StrCpy $7 0
      ${EndIf}
      StrCpy $6 "$6.$7 GB"
    ${ElseIf} $2 >= 1024
      IntOp $6 $2 / 1024
      IntOp $7 $2 % 1024
      IntOp $7 $7 * 10
      IntOp $7 $7 + 512
      IntOp $7 $7 / 1024
      ${If} $7 >= 10
        IntOp $6 $6 + 1
        StrCpy $7 0
      ${EndIf}
      StrCpy $6 "$6.$7 MB"
    ${Else}
      StrCpy $6 "$2 KB"
    ${EndIf}
  FunctionEnd

  ; 刷新目录页空间信息：可用空间取 $INSTDIR 所在盘剩余空间（${DriveSpace} /S=K
  ; 输出 KB 数），所需空间为所有 Section 大小之和（KB 累加），统一经 tmdFormatSize 格式化
  Function tmdDirPageRefreshSpace
    ; 可用空间（取盘符根路径）
    StrCpy $1 $INSTDIR 3
    ${DriveSpace} $1 "/D=F /S=K" $2
    Call tmdFormatSize
    ${NSD_SetText} $tmdSpaceAvail "$(^SpaceAvailable)$6"
    ; 所需空间（遍历所有 Section 累加，索引越界即结束）
    StrCpy $2 0
    StrCpy $3 0
    tmd_space_loop:
      ClearErrors
      SectionGetFlags $3 $4
      IfErrors tmd_space_done
      SectionGetSize $3 $5
      IntOp $2 $2 + $5
      IntOp $3 $3 + 1
      Goto tmd_space_loop
    tmd_space_done:
    Call tmdFormatSize
    ${NSD_SetText} $tmdSpaceReq "$(^SpaceRequired)$6"
  FunctionEnd

  !macro customPageAfterChangeDir
    ; 触发各语言文件加载目录页标题/副标题字符串（MUI 语言文件按此 define
    ; 条件加载；内置目录页被替换后模板不会再定义它，缺了会让 makensis 报
    ; 6040 告警，被 electron-builder 按错误处理）
    !define MUI_DIRECTORYPAGE
    Page custom tmdDirPage tmdDirPageLeave

    ; 自绘目录页：升级安装（--updated）时按模板原行为跳过
    Function tmdDirPage
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT $(MUI_TEXT_DIRECTORY_TITLE) $(MUI_TEXT_DIRECTORY_SUBTITLE)
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ; 布局对齐内置目录页：说明文字 → 目标文件夹分组框（内嵌路径框+浏览按钮）→ 空间信息
      ${NSD_CreateLabel} 0u 0u 100% 30u "$(^DirText)"
      Pop $0
      ${NSD_CreateGroupBox} 0u 44u 100% 38u "$(^DirSubText)"
      Pop $0
      ${NSD_CreateText} 10u 58u -95u 12u "$INSTDIR"
      Pop $tmdDirText
      ${NSD_CreateButton} -80u 58u 70u 12u "$(^BrowseBtn)"
      Pop $0
      ${NSD_OnClick} $0 tmdDirPageBrowse
      ${NSD_CreateLabel} 0u 98u 100% 10u ""
      Pop $tmdSpaceReq
      ${NSD_CreateLabel} 0u 110u 100% 10u ""
      Pop $tmdSpaceAvail
      Call tmdDirPageRefreshSpace
      nsDialogs::Show
    FunctionEnd

    ; 浏览按钮回调：弹出选目录对话框，选定后修正并立即回写文本框，
    ; 路径框即时显示 <所选目录>\TMD，并刷新可用空间
    Function tmdDirPageBrowse
      ${NSD_GetText} $tmdDirText $0
      nsDialogs::SelectFolderDialog "$(^DirBrowseText)" "$0"
      Pop $0
      ${If} $0 != error
        StrCpy $INSTDIR $0
        Call tmdFixInstallDir
        ${NSD_SetText} $tmdDirText $INSTDIR
        Call tmdDirPageRefreshSpace
      ${EndIf}
    FunctionEnd

    ; 目录页 leave：对手工编辑文本框的路径做同样的兜底修正
    Function tmdDirPageLeave
      ${NSD_GetText} $tmdDirText $0
      StrCpy $INSTDIR $0
      Call tmdFixInstallDir
    FunctionEnd
  !macroend
!endif
!endif
