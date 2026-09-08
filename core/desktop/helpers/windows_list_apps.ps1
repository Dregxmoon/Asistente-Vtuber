$ErrorActionPreference = 'Stop'

function Write-Result($Value) {
  $Value | ConvertTo-Json -Depth 5 -Compress
}

try {
  [void][Console]::In.ReadToEnd()
  $Apps = @(Get-StartApps | ForEach-Object {
    @{ name = [string]$_.Name; id = [string]$_.AppID }
  })
  Write-Result @{ ok = $true; apps = $Apps }
} catch {
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message; apps = @() }
}
