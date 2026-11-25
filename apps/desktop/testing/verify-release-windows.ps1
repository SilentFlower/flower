# 从用户下载的首装 ZIP 进入顶层启动器，核对实际窗口属于发行版本。
param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Assets)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("flower-release-" + [Guid]::NewGuid().ToString("N"))
$install = Join-Path $root 'Flower Desktop'
$profile = Join-Path $root 'profile'
$expected = Join-Path $install "versions/$Version/Flower Desktop.exe"
$process = $null
try {
    [IO.Directory]::CreateDirectory($install) | Out-Null
    $zip = Join-Path $Assets "Flower-Desktop-$Version-win32-x64-portable.zip"
    # 按 ZIP 的 UTF-8 文件名标记解压，覆盖非中文 Windows 上的中文条目。
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $install)
    if (!(Test-Path -LiteralPath (Join-Path $install '使用说明.txt') -PathType Leaf)) { throw "Windows 首装 ZIP 缺少中文使用说明" }
    if ((Get-Content -Raw -LiteralPath (Join-Path $install 'current.txt')).Trim() -ne $Version) { throw "启动版本不符" }
    $entry = Join-Path $install 'Flower Desktop.exe'
    Start-Process -FilePath $entry -ArgumentList ('"--user-data-dir=' + $profile + '"') -WorkingDirectory $install
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 350
        $process = Get-Process -Name 'Flower Desktop' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -eq $expected -and $_.MainWindowHandle -ne 0 -and $_.Responding
        } | Select-Object -First 1
    } until ($process -or (Get-Date) -gt $deadline)
    if (!$process) { throw "受管理启动器未显示 $Version 的实际窗口" }
    Write-Output "Windows $Version 首装、解压与启动成功"
} finally {
    if ($process) { [void]$process.CloseMainWindow(); [void]$process.WaitForExit(8000) }
    # 只清理本次解压目录启动的进程。
    Get-Process -Name 'Flower Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected } | Stop-Process -Force
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
