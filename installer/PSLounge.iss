; Compile with build-installer.ps1 after build_exe.bat on Windows.
#ifndef AppVersion
  #error AppVersion must be supplied by the build script.
#endif
#ifndef PackageSource
  #error PackageSource must point to the complete PyInstaller onedir package.
#endif
#ifndef BuildOutput
  #error BuildOutput must be supplied by the build script.
#endif
#define AppName "PS Lounge"
#define AppExeName "PS Lounge.exe"

[Setup]
AppId={{2351C23B-3E88-446A-97C5-408D4B45DBBE}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=PS Lounge
AppPublisherURL=https://github.com/andreyqwerty365-netizen/PSLounge
AppSupportURL=https://github.com/andreyqwerty365-netizen/PSLounge/issues
DefaultDirName={localappdata}\Programs\PS Lounge
DefaultGroupName=PS Lounge
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
OutputDir={#BuildOutput}
OutputBaseFilename=PS-Lounge-{#AppVersion}-Setup
UninstallDisplayIcon={app}\{#AppExeName}
CloseApplications=yes
RestartApplications=no
SetupMutex=PSLounge_Installer

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PackageSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\PS Lounge"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\PS Lounge"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\{cm:UninstallProgram,PS Lounge}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,PS Lounge}"; Flags: nowait postinstall skipifsilent

; No UninstallDelete entry: the separate data directory is always retained.
