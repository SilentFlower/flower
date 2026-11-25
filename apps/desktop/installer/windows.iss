[Setup]
AppId=com.silentflower.flower-desktop
AppName=Flower Desktop
AppVersion={#Version}
AppPublisher=SilentFlower
AppPublisherURL=https://github.com/SilentFlower/flower
DefaultDirName={userpf}\Flower Desktop
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=Flower-Desktop-{#Version}-win32-x64-setup
UninstallDisplayIcon={app}\Flower Desktop.exe
WizardStyle=modern
Compression=zip
SolidCompression=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#Payload}\versions\{#Version}\*"; DestDir: "{app}\versions\{#Version}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\Flower Desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Payload}\.flower-desktop-managed"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Payload}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
; 最后发布版本指针，使稳定启动器始终指向已安装的完整载荷。
Source: "{#Payload}\current.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Flower Desktop"; Filename: "{app}\Flower Desktop.exe"

[Run]
Filename: "{app}\Flower Desktop.exe"; Description: "{cm:LaunchProgram,Flower Desktop}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 自动更新写入的版本也归安装目录所有。用户资料存放在独立的用户数据目录。
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\previous.txt"
Type: files; Name: "{app}\last-update-error.txt"

[Code]
{ 仅管理产品专用目录，并防止旧安装包倒退通过自动更新启用的版本。 }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Root: String;
  Marker, Current: AnsiString;
  ExistingVersion, InstallingVersion: Int64;
begin
  Root := ExpandConstant('{app}');
  if CompareText(Root, ExpandConstant('{userpf}\Flower Desktop')) <> 0 then
  begin
    Result := '请选择 Flower Desktop 默认的用户程序目录。';
    Exit;
  end;
  if not DirExists(Root) then Exit;
  if not LoadStringFromFile(Root + '\.flower-desktop-managed', Marker) or
     (Trim(String(Marker)) <> 'flower-desktop-portable-1') then
  begin
    Result := '目标目录已存在，请先移走该目录中的文件。';
    Exit;
  end;
  if not LoadStringFromFile(Root + '\current.txt', Current) or
     not StrToVersion(Trim(String(Current)), ExistingVersion) or
     not StrToVersion('{#Version}', InstallingVersion) then
  begin
    Result := '无法确认已安装版本。';
    Exit;
  end;
  if ComparePackedVersion(ExistingVersion, InstallingVersion) > 0 then
    Result := '本机已经安装了更新的 Flower Desktop。';
end;
