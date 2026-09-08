$ErrorActionPreference = 'Stop'

function Write-Result($Value) {
  $Value | ConvertTo-Json -Depth 4 -Compress
}

try {
  [void][Console]::In.ReadToEnd()
  $Processes = @(Get-Process | Sort-Object -Property Id | ForEach-Object {
    @{ pid = [int]$_.Id; name = [string]$_.ProcessName }
  })
  Write-Result @{ ok = $true; processes = $Processes }
} catch {
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message; processes = @() }
}
