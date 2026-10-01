[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$CompilerPath
)
$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $SourceDir).Path
if (!(Test-Path -LiteralPath (Join-Path $packagePath 'PS Lounge.exe') -PathType Leaf)) {
    throw 'SourceDir must contain the complete PyInstaller onedir package.'
}
if (!$CompilerPath) {
    $compilerCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    )
    $CompilerPath = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (!$CompilerPath -or !(Test-Path -LiteralPath $CompilerPath -PathType Leaf)) {
    throw 'Install Inno Setup 6.4.3 or provide -CompilerPath to ISCC.exe.'
}
$outputPath = Join-Path $PSScriptRoot ('output\' + $Version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'))
New-Item -ItemType Directory -Path $outputPath | Out-Null
& $CompilerPath "/DAppVersion=$Version" "/DPackageSource=$packagePath" "/DBuildOutput=$outputPath" (Join-Path $PSScriptRoot 'PSLounge.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
Write-Host "Installer: $outputPath"
