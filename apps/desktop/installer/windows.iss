[Setup]
AppId=com.silentflower.flower-desktop
AppName=Flower Desktop
AppVersion={#Version}
AppPublisher=SilentFlower
AppPublisherURL=https://github.com/SilentFlower/flower
DefaultDirName={userpf}\Flower Desktop
DisableWelcomePage=no
DisableDirPage=no
DirExistsWarning=no
DisableReadyPage=yes
ShowLanguageDialog=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=Flower-Desktop-{#Version}-win32-x64-setup
UninstallDisplayIcon={app}\Flower Desktop.exe
SetupIconFile=artwork\flower.ico
WizardImageFile=artwork\wizard-cover.png
WizardSmallImageFile=artwork\wizard-mark.png
WizardImageBackColor=#382B40
WizardBackColor=#FBFAF7
WizardSizePercent=140,122
WizardKeepAspectRatio=yes
WizardStyle=modern light windows11 hidebevels
Compression=zip
SolidCompression=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[LangOptions]
english.DialogFontName=Segoe UI
chinesesimplified.DialogFontName=Microsoft YaHei UI
english.WelcomeFontName=Segoe UI
chinesesimplified.WelcomeFontName=Microsoft YaHei UI
WelcomeFontSize=18

[Messages]
ClickNext=
ClickFinish=
chinesesimplified.ButtonBack=上一步
chinesesimplified.ButtonNext=继续
chinesesimplified.ButtonInstall=开始安装
chinesesimplified.ButtonFinish=完成
english.ButtonBack=Back
english.ButtonNext=Continue
english.WelcomeLabel1=Install Flower Desktop
chinesesimplified.WelcomeLabel1=安装 Flower Desktop
english.WelcomeLabel2=Set up your desktop workspace. Choose where to install Flower and how to open it.
chinesesimplified.WelcomeLabel2=选择安装位置和启动方式，开始使用你的桌面工作台。
english.WizardSelectDir=Installation folder
chinesesimplified.WizardSelectDir=安装位置
english.SelectDirDesc=Choose where Flower Desktop will be installed.
chinesesimplified.SelectDirDesc=选择用来存放程序和后续更新的文件夹。
english.SelectDirLabel3=Folder
chinesesimplified.SelectDirLabel3=安装文件夹
english.WizardSelectTasks=Installation options
chinesesimplified.WizardSelectTasks=安装选项
english.SelectTasksDesc=Flower Desktop is always available in the Start menu.
chinesesimplified.SelectTasksDesc=安装后可以从 Windows 开始菜单打开 Flower Desktop。
english.SelectTasksLabel2=Installation folder
chinesesimplified.SelectTasksLabel2=安装文件夹
english.WizardInstalling=Installing Flower Desktop
chinesesimplified.WizardInstalling=正在安装
english.InstallingLabel=Copying application files and setting up shortcuts.
chinesesimplified.InstallingLabel=正在写入程序文件并设置快捷方式。
english.FinishedHeadingLabel=Flower Desktop is ready
chinesesimplified.FinishedHeadingLabel=安装完成
english.FinishedLabel=You can now open Flower Desktop from the Start menu.
chinesesimplified.FinishedLabel=你可以立即启动 Flower Desktop，也可以稍后从开始菜单打开。
english.FinishedLabelNoIcons=Flower Desktop is installed.
chinesesimplified.FinishedLabelNoIcons=Flower Desktop 已安装。

[CustomMessages]
english.BrowseFolder=Browse…
chinesesimplified.BrowseFolder=浏览…
english.DriveRoot=Choose a dedicated folder inside this drive.
chinesesimplified.DriveRoot=请在磁盘中选择一个专用文件夹。
english.FolderInUse=This folder already contains other files. Choose an empty folder or an existing Flower Desktop installation.
chinesesimplified.FolderInUse=此目录已有其他文件，请选择空文件夹或原有的 Flower Desktop 安装目录。
english.InvalidFolder=Choose a writable folder without a directory junction or symbolic link.
chinesesimplified.InvalidFolder=请选择可写入的普通文件夹。此路径包含目录联接或符号链接。
english.InvalidVersion=The existing installation version could not be verified.
chinesesimplified.InvalidVersion=无法确认原有 Flower Desktop 安装的版本。
english.NewerVersion=A newer Flower Desktop version is already installed here.
chinesesimplified.NewerVersion=此目录已经安装了更新的 Flower Desktop。
english.DesktopTask=Create a desktop shortcut
chinesesimplified.DesktopTask=创建桌面快捷方式

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopTask}"

[Files]
Source: "{#Payload}\versions\{#Version}\*"; DestDir: "{app}\versions\{#Version}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\Flower Desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Payload}\.flower-desktop-managed"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Payload}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
; 最后发布版本指针，使稳定启动器始终指向已安装的完整载荷。
Source: "{#Payload}\current.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\Flower Desktop"; Filename: "{app}\Flower Desktop.exe"; IconFilename: "{app}\Flower Desktop.exe"; Tasks: desktopicon
Name: "{userprograms}\Flower Desktop"; Filename: "{app}\Flower Desktop.exe"; IconFilename: "{app}\Flower Desktop.exe"

[Run]
Filename: "{app}\Flower Desktop.exe"; Description: "{cm:LaunchProgram,Flower Desktop}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只清除程序生成的指针文件，版本目录按安装身份单独处理。
Type: files; Name: "{app}\previous.txt"
Type: files; Name: "{app}\last-update-error.txt"

[Code]
var
  SelectedFolder: TNewStaticText;
function GetFileAttributesW(Path: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';

{ 检查目标及已有父目录。便携更新器要求真实的安装路径。 }
function HasReparsePoint(Path: String): Boolean;
var
  Parent: String;
  Attr: LongWord;
begin
  repeat
    Attr := GetFileAttributesW(Path);
    if (Attr <> $FFFFFFFF) and ((Attr and $400) <> 0) then begin
      Result := True;
      Exit;
    end;
    Parent := ExtractFileDir(Path);
    if Parent = Path then Exit;
    Path := Parent;
  until Path = '';
end;

function DirectoryIsEmpty(const Path: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Path) + '*', Entry) then try
    repeat
      if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
        Result := False;
        Exit;
      end;
    until not FindNext(Entry);
  finally
    FindClose(Entry);
  end;
end;

{ 新目录、空目录和经过核验的原安装目录均可用于安装。 }
function DirectoryIssue(const Root: String): String;
var
  Marker, Current: AnsiString;
  ExistingVersion, InstallingVersion: Int64;
begin
  if AddBackslash(Root) = AddBackslash(ExtractFileDrive(Root)) then begin
    Result := CustomMessage('DriveRoot');
    Exit;
  end;
  if HasReparsePoint(Root) then begin
    Result := CustomMessage('InvalidFolder');
    Exit;
  end;
  if FileExists(Root) then begin
    Result := CustomMessage('FolderInUse');
    Exit;
  end;
  if not DirExists(Root) or DirectoryIsEmpty(Root) then Exit;
  if not LoadStringFromFile(AddBackslash(Root) + '.flower-desktop-managed', Marker) or
     (Trim(String(Marker)) <> 'flower-desktop-portable-1') then begin
    Result := CustomMessage('FolderInUse');
    Exit;
  end;
  if not LoadStringFromFile(AddBackslash(Root) + 'current.txt', Current) or
     not StrToVersion(Trim(String(Current)), ExistingVersion) or
     not StrToVersion('{#Version}', InstallingVersion) or
     not FileExists(AddBackslash(Root) + 'Flower Desktop.exe') then begin
    Result := CustomMessage('InvalidVersion');
    Exit;
  end;
  if ComparePackedVersion(ExistingVersion, InstallingVersion) > 0 then
    Result := CustomMessage('NewerVersion');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Issue: String;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and not WizardSilent then begin
    Issue := DirectoryIssue(RemoveBackslashUnlessRoot(ExpandFileName(WizardForm.DirEdit.Text)));
    Result := Issue = '';
    if not Result then SuppressibleMsgBox(Issue, mbError, MB_OK, IDOK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := DirectoryIssue(RemoveBackslashUnlessRoot(ExpandConstant('{app}')));
end;

{ 卸载只回收带产品和版本标记的更新载荷；保留用户放在安装目录中的其他内容。 }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root, Dir: String;
  Entry: TFindRec;
  Marker: AnsiString;
  Version: Int64;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  Root := ExpandConstant('{app}\versions');
  if HasReparsePoint(Root) then Exit;
  if FindFirst(Root + '\*', Entry) then try
    repeat
      Dir := Root + '\' + Entry.Name;
      if ((Entry.Attributes and $410) = $10) and StrToVersion(Entry.Name, Version) and
         FileExists(Dir + '\Flower Desktop.exe') and
         LoadStringFromFile(Dir + '\flower-desktop-build.json', Marker) and
         (Pos('"product":"Flower Desktop"', String(Marker)) > 0) and
         (Pos('"version":"' + Entry.Name + '"', String(Marker)) > 0) then
        DelTree(Dir, True, True, True);
    until not FindNext(Entry);
  finally
    FindClose(Entry);
  end;
  RemoveDir(Root);
end;

procedure InitializeWizard;
var
  Rail: TBitmapImage;
  VersionLabel: TNewStaticText;
  RailWidth, Inset, BodyWidth, BodyTop: Integer;
begin
  RailWidth := WizardForm.WizardBitmapImage.Width;
  Inset := ScaleX(22);
  Rail := TBitmapImage.Create(WizardForm);
  Rail.Parent := WizardForm.InnerPage;
  Rail.Bitmap := WizardForm.WizardBitmapImage.Bitmap;
  Rail.Stretch := True;
  Rail.SetBounds(0, 0, RailWidth, WizardForm.InnerPage.ClientHeight);
  Rail.Anchors := [akLeft, akTop, akBottom];

  WizardForm.MainPanel.SetBounds(RailWidth, 0,
    WizardForm.InnerPage.ClientWidth - RailWidth, ScaleY(86));
  WizardForm.WizardSmallBitmapImage.Visible := False;
  BodyWidth := WizardForm.MainPanel.Width - 2 * Inset;
  WizardForm.PageNameLabel.SetBounds(Inset, ScaleY(17), BodyWidth, ScaleY(35));
  WizardForm.PageNameLabel.Font.Size := 17;
  WizardForm.PageDescriptionLabel.SetBounds(Inset, ScaleY(57), BodyWidth, ScaleY(28));
  BodyTop := WizardForm.MainPanel.Height + ScaleY(20);
  WizardForm.InnerNotebook.SetBounds(RailWidth + Inset, BodyTop, BodyWidth,
    WizardForm.InnerPage.ClientHeight - BodyTop - ScaleY(10));

  WizardForm.SelectDirBitmapImage.Visible := False;
  WizardForm.SelectDirLabel.SetBounds(0, 0, BodyWidth, ScaleY(20));
  WizardForm.SelectDirLabel.Font.Style := [fsBold];
  WizardForm.SelectDirBrowseLabel.Visible := False;
  WizardForm.DirBrowseButton.Caption := CustomMessage('BrowseFolder');
  WizardForm.DirBrowseButton.SetBounds(BodyWidth - ScaleX(72), ScaleY(25), ScaleX(72), ScaleY(24));
  WizardForm.DirEdit.SetBounds(0, ScaleY(26), BodyWidth - ScaleX(80), WizardForm.DirEdit.Height);
  WizardForm.SelectTasksLabel.Font.Style := [fsBold];
  SelectedFolder := TNewStaticText.Create(WizardForm);
  SelectedFolder.Parent := WizardForm.SelectTasksPage;
  SelectedFolder.AutoSize := False;
  SelectedFolder.WordWrap := True;
  SelectedFolder.SetBounds(0, ScaleY(24), BodyWidth, ScaleY(44));
  SelectedFolder.Anchors := [akLeft, akTop, akRight];
  WizardForm.TasksList.Top := ScaleY(80);
  WizardForm.TasksList.Height := WizardForm.SelectTasksPage.ClientHeight - WizardForm.TasksList.Top;
  WizardForm.FilenameLabel.Visible := False;
  VersionLabel := TNewStaticText.Create(WizardForm);
  VersionLabel.Parent := WizardForm;
  VersionLabel.Caption := 'Windows x64   ·   {#Version}';
  VersionLabel.Font.Size := 9;
  VersionLabel.Font.Color := $6B616A;
  VersionLabel.Left := ScaleX(18);
  VersionLabel.Top := WizardForm.CancelButton.Top + (WizardForm.CancelButton.Height - VersionLabel.Height) div 2;
  VersionLabel.Anchors := [akLeft, akBottom];
  WizardForm.NextButton.Font.Style := [fsBold];
end;

{ 为首页和完成页按实际文本宽度排版，兼顾中文、英文和系统缩放。 }
procedure LayoutHero(Title, Detail: TNewStaticText; Finished: Boolean);
var
  X, W, Top: Integer;
begin
  X := WizardForm.WizardBitmapImage.Width + ScaleX(24);
  W := WizardForm.OuterNotebook.ClientWidth - X - ScaleX(22);
  Top := WizardForm.OuterNotebook.ClientHeight div 3;
  if Finished then Top := Top - ScaleY(12);
  Title.Caption := Trim(Title.Caption);
  Title.Font.Size := 21;
  Title.Font.Color := $302737;
  Title.SetBounds(X, Top, W, ScaleY(72));
  WizardForm.AdjustLabelHeight(Title);
  Detail.Font.Size := 10;
  Detail.Font.Color := $655D64;
  Detail.SetBounds(X, Title.Top + Title.Height + ScaleY(12), W, ScaleY(75));
  WizardForm.AdjustLabelHeight(Detail);
  if Finished then begin
    WizardForm.RunList.Left := X;
    WizardForm.RunList.Width := W;
    WizardForm.RunList.Top := Detail.Top + Detail.Height + ScaleY(17);
    WizardForm.RunList.Height := ScaleY(50);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpWelcome then begin
    WizardForm.WelcomeLabel2.Caption := SetupMessage(msgWelcomeLabel2);
    LayoutHero(WizardForm.WelcomeLabel1, WizardForm.WelcomeLabel2, False);
  end else if (CurPageID = wpFinished) and not WizardForm.YesRadio.Visible then
    LayoutHero(WizardForm.FinishedHeadingLabel, WizardForm.FinishedLabel, True)
  else if CurPageID = wpSelectTasks then begin
    SelectedFolder.Caption := WizardDirValue;
    WizardForm.AdjustLabelHeight(SelectedFolder);
    WizardForm.TasksList.Top := SelectedFolder.Top + SelectedFolder.Height + ScaleY(28);
    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
  end;
end;

{ 重新安装时取消快捷方式，只移除仍指向本安装目录的入口。 }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Link: String;
  Shell, Shortcut: Variant;
begin
  if (CurStep <> ssPostInstall) or WizardIsTaskSelected('desktopicon') then Exit;
  Link := ExpandConstant('{userdesktop}\Flower Desktop.lnk');
  if not FileExists(Link) then Exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Shortcut := Shell.CreateShortcut(Link);
    if CompareText(Shortcut.TargetPath, ExpandConstant('{app}\Flower Desktop.exe')) = 0 then
      DeleteFile(Link);
  except
    Log('无法核实桌面快捷方式，保留原文件。');
  end;
end;
