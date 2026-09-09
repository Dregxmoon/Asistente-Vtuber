$ErrorActionPreference = 'Stop'

function Write-Result($Value) {
  $Value | ConvertTo-Json -Depth 12 -Compress
}

try {
  $Request = ( [Console]::In.ReadToEnd() | ConvertFrom-Json )
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Write-Result @{ ok = $false; error = 'Windows UI Automation no está disponible' }
  exit 0
}

function Get-SafeProperty($Element, $Property, $Default) {
  try { return $Element.GetCurrentPropertyValue($Property, $true) } catch { return $Default }
}

function Get-RequestNumber($Object, $Name, $Default) {
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property -or $null -eq $Property.Value) { return $Default }
  return [int]$Property.Value
}

function Get-RequestText($Object, $Name) {
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property -or $null -eq $Property.Value) { return '' }
  return [string]$Property.Value
}

function Get-Node($Element, $Depth, $Path) {
  $Rect = Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty) $null
  $Bounds = $null
  if ($null -ne $Rect -and -not $Rect.IsEmpty) {
    $Bounds = @{ x = $Rect.X; y = $Rect.Y; width = $Rect.Width; height = $Rect.Height }
  }
  $ControlType = Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) $null
  return @{
    path = $Path
    processId = [int](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::ProcessIdProperty) 0)
    name = [string](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::NameProperty) '')
    automationId = [string](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '')
    role = if ($null -ne $ControlType) { $ControlType.ProgrammaticName.Replace('ControlType.', '').ToLowerInvariant() } else { 'unknown' }
    enabled = [bool](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty) $false)
    focused = [bool](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty) $false)
    offscreen = [bool](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty) $true)
    bounds = $Bounds
    depth = $Depth
  }
}

function Test-Target($Element, $Target) {
    $Pid = [int](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::ProcessIdProperty) 0)
    $Name = [string](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::NameProperty) '')
    $AutomationId = [string](Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) '')
    $ControlType = Get-SafeProperty $Element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) $null
    $Role = if ($null -ne $ControlType) { $ControlType.ProgrammaticName.Replace('ControlType.', '').ToLowerInvariant() } else { 'unknown' }
    if (($Target.processId -and $Pid -ne [int]$Target.processId) -or
        ($Target.automationId -and $AutomationId -ne [string]$Target.automationId) -or
        ($Target.name -and $Name -ne [string]$Target.name) -or
        ($Target.role -and $Role -ne [string]$Target.role)) { return $false }
    return $true
}

function Find-Target($Target) {
  $Root = [System.Windows.Automation.AutomationElement]::RootElement
  $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $Current = $Root
  $PathText = [string]$Target.path
  if (-not [string]::IsNullOrWhiteSpace($PathText)) {
    $ValidPath = $true
    foreach ($Part in $PathText.Split('/')) {
      $Wanted = 0
      if (-not [int]::TryParse($Part, [ref]$Wanted)) { $ValidPath = $false; break }
      $Child = $Walker.GetFirstChild($Current)
      for ($Index = 0; $Index -lt $Wanted -and $null -ne $Child; $Index++) {
        $Child = $Walker.GetNextSibling($Child)
      }
      if ($null -eq $Child) { $ValidPath = $false; break }
      $Current = $Child
    }
    if ($ValidPath -and (Test-Target $Current $Target)) { return $Current }
  }

  $All = $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $Matches = [System.Collections.Generic.List[object]]::new()
  foreach ($Element in $All) {
    if (Test-Target $Element $Target) { $Matches.Add($Element) }
  }
  if ($Matches.Count -eq 1) { return $Matches[0] }
  if ($Matches.Count -gt 1) { throw 'La referencia coincide con varios controles; vuelve a observar' }
  return $null
}

if ($Request.operation -eq 'health') {
  Write-Result @{ ok = $true; platform = 'win32'; backend = 'windows-ui-automation' }
  exit 0
}

if ($Request.operation -eq 'snapshot') {
  $MaxDepth = [Math]::Max(1, [Math]::Min((Get-RequestNumber $Request 'maxDepth' 6), 12))
  $MaxNodes = [Math]::Max(10, [Math]::Min((Get-RequestNumber $Request 'maxNodes' 250), 1000))
  $Application = Get-RequestText $Request 'application'
  $Nodes = [System.Collections.Generic.List[object]]::new()
  $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  function Visit-Element($Element, $Depth, $Path, $WindowName) {
    if ($Nodes.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) { return }
    $Node = Get-Node $Element $Depth $Path
    if ($Depth -eq 0) { $WindowName = $Node.name }
    $Node.window = $WindowName
    $Nodes.Add($Node)
    $Child = $Walker.GetFirstChild($Element)
    $Index = 0
    while ($null -ne $Child -and $Nodes.Count -lt $MaxNodes) {
      Visit-Element $Child ($Depth + 1) ($Path + '/' + $Index) $WindowName
      $Child = $Walker.GetNextSibling($Child)
      $Index++
    }
  }

  $Root = [System.Windows.Automation.AutomationElement]::RootElement
  $Window = $Walker.GetFirstChild($Root)
  $WindowIndex = 0
  while ($null -ne $Window -and $Nodes.Count -lt $MaxNodes) {
    $WindowName = [string](Get-SafeProperty $Window ([System.Windows.Automation.AutomationElement]::NameProperty) '')
    if (-not $Application -or $WindowName.IndexOf($Application, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Visit-Element $Window 0 ([string]$WindowIndex) $WindowName
    }
    $Window = $Walker.GetNextSibling($Window)
    $WindowIndex++
  }
  Write-Result @{ ok = $true; platform = 'win32'; nodes = $Nodes; truncated = ($Nodes.Count -ge $MaxNodes) }
  exit 0
}

if ($Request.operation -ne 'execute') {
  Write-Result @{ ok = $false; error = 'Operación desconocida' }
  exit 0
}

if ([string]$Request.action -eq 'pointer_click') {
  try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KaoruPointer {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
    $X = [int]$Request.input.x
    $Y = [int]$Request.input.y
    if (-not [KaoruPointer]::SetCursorPos($X, $Y)) { throw 'Windows rechazó la posición del puntero' }
    [KaoruPointer]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [KaoruPointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Write-Result @{ ok = $true; executed = $true; evidence = @{ x = $X; y = $Y } }
  } catch {
    Write-Result @{ ok = $false; error = [string]$_.Exception.Message }
  }
  exit 0
}

$Element = Find-Target $Request.target
if ($null -eq $Element) {
  Write-Result @{ ok = $false; error = 'El elemento cambió o ya no existe'; stale = $true }
  exit 0
}

try {
  switch ([string]$Request.action) {
    'focus' { $Element.SetFocus() }
    'click' {
      $Pattern = $null
      if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$Pattern)) {
        throw 'El elemento no expone InvokePattern'
      }
      ([System.Windows.Automation.InvokePattern]$Pattern).Invoke()
    }
    'select' {
      $Pattern = $null
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$Pattern)) {
        ([System.Windows.Automation.SelectionItemPattern]$Pattern).Select()
      } elseif ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$Pattern)) {
        ([System.Windows.Automation.InvokePattern]$Pattern).Invoke()
      } else { throw 'El elemento no se puede seleccionar' }
    }
    'type' {
      $Value = [string]$Request.input.value
      $Pattern = $null
      if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$Pattern)) {
        throw 'El elemento no expone ValuePattern'
      }
      ([System.Windows.Automation.ValuePattern]$Pattern).SetValue($Value)
    }
    'press' {
      $Element.SetFocus()
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait([string]$Request.input.key)
    }
    'scroll' {
      $Direction = [string]$Request.input.direction
      $Amount = [Math]::Max(1, [Math]::Min(10, [int]$Request.input.amount))
      $Pattern = $null
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$Pattern)) {
        $Horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
        $Vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
        switch ($Direction) {
          'up' { $Vertical = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'down' { $Vertical = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          'left' { $Horizontal = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'right' { $Horizontal = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          default { throw 'Dirección de desplazamiento no permitida' }
        }
        for ($Index = 0; $Index -lt $Amount; $Index++) {
          ([System.Windows.Automation.ScrollPattern]$Pattern).Scroll($Horizontal, $Vertical)
        }
      } else {
        $Element.SetFocus()
        Add-Type -AssemblyName System.Windows.Forms
        $Key = if ($Direction -eq 'up') { '{PGUP}' } elseif ($Direction -eq 'down') { '{PGDN}' } elseif ($Direction -eq 'left') { '{LEFT}' } elseif ($Direction -eq 'right') { '{RIGHT}' } else { throw 'Dirección de desplazamiento no permitida' }
        for ($Index = 0; $Index -lt $Amount; $Index++) {
          [System.Windows.Forms.SendKeys]::SendWait($Key)
        }
      }
    }
    'close' {
      $Pattern = $null
      if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$Pattern)) {
        throw 'El elemento no expone WindowPattern'
      }
      ([System.Windows.Automation.WindowPattern]$Pattern).Close()
    }
    default { throw 'Acción UI Automation desconocida' }
  }
  Start-Sleep -Milliseconds 150
  $Evidence = Get-Node $Element 0 ''
  if ([string]$Request.action -eq 'type') {
    $Evidence.valueLength = ([string]$Request.input.value).Length
  }
  Write-Result @{ ok = $true; executed = $true; evidence = $Evidence }
} catch {
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message }
}
