param([Parameter(Mandatory=$true)][string]$Launch)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
  $spec = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Launch)) | ConvertFrom-Json
  exit [RsiAgentJob]::Run([string]$spec.executable, [string[]]@($spec.args))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 125
}
