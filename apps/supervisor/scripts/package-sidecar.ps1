param([ValidateSet('debug','release')][string]$Profile = 'release')
$ErrorActionPreference = 'Stop'
$strataRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$strataTarget = Join-Path $strataRoot 'apps/desktop/src-tauri/target'
$strataManifest = Join-Path $strataRoot 'Cargo.toml'
$strataArguments = @('build','--manifest-path',$strataManifest,'-p','strata-supervisor','--target-dir',$strataTarget)
if ($Profile -eq 'release') { $strataArguments += '--release' }
& cargo @strataArguments
if ($LASTEXITCODE -ne 0) { throw '独立后台编译失败' }
$strataHost = (& rustc -vV | Select-String '^host: ').Line.Substring(6).Trim()
$strataBinary = Join-Path $strataTarget "$Profile/strata-supervisor.exe"
$strataDistribution = Join-Path $strataRoot 'apps/desktop/src-tauri/binaries'
New-Item -ItemType Directory -Path $strataDistribution -Force | Out-Null
$strataPackagedBinary = Join-Path $strataDistribution "strata-supervisor-$strataHost.exe"
Copy-Item -LiteralPath $strataBinary -Destination $strataPackagedBinary -Force
Write-Output "独立后台已打包: $strataPackagedBinary"
