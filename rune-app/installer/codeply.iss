; Yune's Windows installer (Inno Setup 6): Codeply.exe (the file keeps its name, so updates swap it) and the engine it ships with
; (resources\dsh-runtime: DSH and Node; resources\codeply-cli), installed for this user without
; admin rights, with Start menu and desktop shortcuts and an uninstall entry. Built by
; .github/workflows/rune-windows.yml from dist\Codeply-Rune (the same folder the zip holds):
;   ISCC /DAppVersion=4.0.0 /DSourceDir=...\dist\Codeply-Rune /DOutputDir=...\dist [/DIconFile=...] codeply.iss
; An install over an older one replaces it in place (same AppId); the engine's data
; (%USERPROFILE%\.codeply) is never touched, so chats and settings survive updates and uninstalls.

#ifndef AppVersion
  #define AppVersion "4.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\Codeply-Rune"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
AppId={{B7673CFE-5842-4181-B51D-B380E8B21909}
AppName=Yune
AppVersion={#AppVersion}
AppVerName=Yune {#AppVersion}
AppPublisher=Eris Labs
AppPublisherURL=https://codeply.app/yune
AppSupportURL=https://codeply.app/yune
; An install from before the rename stays where it is (same AppId, previous folder).
DefaultDirName={localappdata}\Programs\Yune
DefaultGroupName=Yune
DisableProgramGroupPage=yes
DisableDirPage=auto
DisableReadyPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Codeply-Setup
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
UninstallDisplayName=Yune
UninstallDisplayIcon={app}\Codeply.exe
; Updating while Yune runs: close it (and its engine) first, open it again after.
CloseApplications=force
RestartApplications=no
#ifdef IconFile
SetupIconFile={#IconFile}
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; An update replaces the engine whole, so files a newer engine dropped don't linger.
Type: filesandordirs; Name: "{app}\resources\dsh-runtime"
Type: filesandordirs; Name: "{app}\resources\codeply-cli"
; The shortcuts from before the app was called Yune.
Type: files; Name: "{autoprograms}\Codeply.lnk"
Type: files; Name: "{autodesktop}\Codeply.lnk"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Yune"; Filename: "{app}\Codeply.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Yune"; Filename: "{app}\Codeply.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Codeply.exe"; Description: "{cm:LaunchProgram,Yune}"; Flags: nowait postinstall skipifsilent
; An update the app started (Codeply-Setup.exe /SILENT, update.rs): open Yune again after.
Filename: "{app}\Codeply.exe"; Flags: nowait; Check: WizardSilent

[UninstallDelete]
; What the app wrote beside itself (the installed files go on their own; your data in
; %USERPROFILE%\.codeply stays).
Type: filesandordirs; Name: "{app}\resources"
