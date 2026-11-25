# 用真实向导安装到自选目录，同时核对默认目录、两个快捷方式、防降级和卸载边界。
param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Setup)
$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:RUNNER_TEMP ('Flower 安装验收 ' + [guid]::NewGuid())
$root = Join-Path $folder '应用程序/Flower Desktop'
$profile = Join-Path $folder '使用者资料'
$default = Join-Path $env:LOCALAPPDATA 'Programs/Flower Desktop'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Flower Desktop.lnk'
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Flower Desktop.lnk'
if ((Test-Path $default) -or (Test-Path $desktop) -or (Test-Path $menu)) { throw '本项验收需要干净的测试账户' }
$shell = New-Object -ComObject WScript.Shell
function Run-Installer($Path, $Options = '') {
    (Start-Process -FilePath $Path -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART $Options" -Wait -PassThru).ExitCode
}
function Uninstall($Location) {
    $remove = (Get-ChildItem -LiteralPath $Location -Filter 'unins*.exe' | Select-Object -First 1).FullName
    if (!$remove -or (Run-Installer $remove) -ne 0) { throw '卸载失败' }
}
$process = $null
try {
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $screens = Join-Path $env:RUNNER_TEMP 'wizard-evidence'
    python (Join-Path $PSScriptRoot 'verify-setup-wizard.py') $Setup $screens $root --install
    if ($LASTEXITCODE) { throw '真实安装向导验收失败' }
    $entry = Join-Path $root 'Flower Desktop.exe'
    $expected = Join-Path $root "versions/$Version/Flower Desktop.exe"
    $pointer = Join-Path $root 'current.txt'
    foreach ($link in @($desktop, $menu)) {
        $shortcut = $shell.CreateShortcut($link)
        if ($shortcut.TargetPath -ne $entry -or $shortcut.IconLocation -notlike "$entry,*") { throw "快捷方式目标或图标错误 $link" }
    }
    if ((Get-Content -Raw $pointer).Trim() -ne $Version) { throw '版本指针错误' }
    Start-Process -FilePath ($shell.CreateShortcut($desktop).TargetPath) -ArgumentList ('"--user-data-dir=' + $profile + '"')
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 350
        $process = Get-Process -Name 'Flower Desktop' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -eq $expected -and $_.MainWindowHandle -ne 0 -and $_.Responding
        } | Select-Object -First 1
    } until ($process -or (Get-Date) -gt $deadline)
    if (!$process) { throw '桌面快捷方式未启动自选目录中的实际应用' }
    [void]$process.CloseMainWindow()
    if (!$process.WaitForExit(10000)) { throw '测试窗口未正常退出' }
    $custom = '/DIR="' + $root + '"'
    [IO.File]::WriteAllText($pointer, '65535.65535.65535')
    if ((Run-Installer $Setup $custom) -eq 0 -or (Get-Content -Raw $pointer) -ne '65535.65535.65535') { throw '旧安装包覆盖了新指针' }
    [IO.File]::WriteAllText($pointer, $Version)
    if ((Run-Installer $Setup ($custom + ' /TASKS=""')) -ne 0 -or (Test-Path $desktop)) { throw '重新安装取消桌面快捷方式失败' }
    $keep = Join-Path $root 'versions/保留我的文件.txt'
    [IO.File]::WriteAllText($keep, 'keep')
    Uninstall $root
    if ((Test-Path $entry) -or (Test-Path $menu) -or !(Test-Path $keep) -or !(Test-Path $profile)) { throw '自选目录卸载边界有误' }
    if ((Run-Installer $Setup $custom) -eq 0 -or (Get-Content -Raw $keep) -ne 'keep') { throw '误接管已有其他文件的目录' }
    if ((Run-Installer $Setup ('/DIR="' + $default + '" /TASKS=""')) -ne 0 -or (Test-Path $desktop)) { throw '默认目录或取消快捷方式异常' }
    Uninstall $default
    Write-Output "Windows $Version 品牌向导、自选目录、快捷方式、防降级及卸载全部通过"
} finally {
    if ($process -and !$process.HasExited) { $process.Kill() }
    Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
}
