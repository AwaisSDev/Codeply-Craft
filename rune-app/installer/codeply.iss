; Codeply's Windows installer (Inno Setup 6): Codeply.exe and the engine it ships with
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
AppName=Codeply
AppVersion={#AppVersion}
AppVerName=Codeply {#AppVersion}
AppPublisher=Codeply
AppPublisherURL=https://codeply.app
AppSupportURL=https://codeply.app
DefaultDirName={localappdata}\Programs\Codeply
DefaultGroupName=Codeply
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
UninstallDisplayName=Codeply
UninstallDisplayIcon={app}\Codeply.exe
; Updating while Codeply runs: close it (and its engine) first, open it again after.
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

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Codeply"; Filename: "{app}\Codeply.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Codeply"; Filename: "{app}\Codeply.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Codeply.exe"; Description: "{cm:LaunchProgram,Codeply}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; What the app wrote beside itself (the installed files go on their own; your data in
; %USERPROFILE%\.codeply stays).
Type: filesandordirs; Name: "{app}\resources"
