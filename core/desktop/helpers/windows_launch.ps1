$ErrorActionPreference = 'Stop'

function Write-Result($Value) {
  $Value | ConvertTo-Json -Depth 5 -Compress
}

try {
  $Request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  $Target = [string]$Request.target
  if ([string]::IsNullOrWhiteSpace($Target)) { throw 'Destino vacío' }
  $Arguments = @()
  if ($null -ne $Request.args) { $Arguments = @($Request.args | ForEach-Object { [string]$_ }) }
  $Process = Start-Process -FilePath $Target -ArgumentList $Arguments -PassThru
  Write-Result @{ ok = $true; processId = $Process.Id }
} catch {
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message }
}
