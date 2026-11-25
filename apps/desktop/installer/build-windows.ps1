# 从已发布并核验摘要的便携包生成当前用户的安装程序。
param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Downloads,
      [Parameter(Mandatory)][string]$BuildDir, [Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})$') { throw '无效版本号' }
$portable = "Flower-Desktop-$Version-win32-x64-portable.zip"
$zip = Join-Path $Downloads $portable
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = @(Get-Content -LiteralPath (Join-Path $Downloads 'SHA256SUMS.txt'))
if ($sums -cnotcontains "$hash  $portable") { throw '便携包与正式版公开摘要不符' }
$compilerInstaller = Join-Path $Downloads 'innosetup-7.1.1-x64.exe'
if ((Get-FileHash -LiteralPath $compilerInstaller).Hash -ne '8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0') { throw 'Inno Setup 编译工具摘要不符' }
$compiler = Join-Path $BuildDir 'compiler'
$payload = Join-Path $BuildDir 'payload'
[IO.Directory]::CreateDirectory($BuildDir) | Out-Null
[IO.Directory]::CreateDirectory($Output) | Out-Null
$setup = Start-Process $compilerInstaller -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /NOICONS /DIR=`"$compiler`"" -Wait -PassThru
if ($setup.ExitCode) { throw "编译工具安装失败 $($setup.ExitCode)" }
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $payload)
if ((Get-Content -LiteralPath (Join-Path $payload current.txt) -Raw).Trim() -cne $Version) { throw '便携包版本指针与标签不符' }
& (Join-Path $compiler 'ISCC.exe') "/DVersion=$Version" "/DPayload=$payload" "/DOutDir=$Output" (Join-Path $PSScriptRoot 'windows.iss')
if ($LASTEXITCODE) { throw '安装 EXE 编译失败' }
