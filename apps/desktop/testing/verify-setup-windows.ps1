# 在独立 Windows runner 中实测用户级安装、开始菜单入口、防降级与卸载。
param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Setup)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Programs/Flower Desktop'
if (Test-Path $root) { throw '本项验收需要空的测试用户安装目录' }
function Run-Installer($Path) {
    (Start-Process -FilePath $Path -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru).ExitCode
}
if ((Run-Installer $Setup) -ne 0) { throw '安装失败' }
$profile = Join-Path $env:RUNNER_TEMP ('flower-setup-profile-' + [guid]::NewGuid())
$process = $null
try {
    $pointer = Join-Path $root 'current.txt'
    $entry = Join-Path $root 'Flower Desktop.exe'
    $expected = Join-Path $root "versions/$Version/Flower Desktop.exe"
    $link = Join-Path ([Environment]::GetFolderPath('Programs')) 'Flower Desktop.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    if ($shortcut.TargetPath -ne $entry -or (Get-Content -Raw $pointer).Trim() -ne $Version) { throw '开始菜单或版本指针错误' }
    Start-Process -FilePath $shortcut.TargetPath -ArgumentList ('"--user-data-dir=' + $profile + '"')
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 350
        $process = Get-Process -Name 'Flower Desktop' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -eq $expected -and $_.MainWindowHandle -ne 0 -and $_.Responding
        } | Select-Object -First 1
    } until ($process -or (Get-Date) -gt $deadline)
    if (!$process) { throw '安装后未显示对应版本的实际窗口' }
    [void]$process.CloseMainWindow()
    if (!$process.WaitForExit(10000)) { throw '测试窗口未正常退出' }
    [IO.File]::WriteAllText($pointer, '65535.65535.65535')
    if ((Run-Installer $Setup) -eq 0 -or (Get-Content -Raw $pointer) -ne '65535.65535.65535') { throw '旧安装器覆盖了新版本' }
    [IO.File]::WriteAllText($pointer, $Version)
    $remove = (Get-ChildItem -LiteralPath $root -Filter 'unins*.exe' | Select-Object -First 1).FullName
    if (!$remove -or (Run-Installer $remove) -ne 0) { throw '卸载失败' }
    if ((Test-Path $entry) -or (Test-Path $link) -or !(Test-Path $profile)) { throw '卸载后程序、快捷方式或用户资料状态错误' }
    Write-Output "Windows $Version 安装、开始菜单启动、防降级及卸载通过"
} finally {
    if ($process -and !$process.HasExited) { $process.Kill() }
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
