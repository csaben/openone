# Long-lived helper: reads one JSON request per line on stdin, answers one JSON line.
#   {"op":"tabs"}                              -> list Windows Terminal tabs
#   {"op":"focus","tab":"regex","index":1}     -> select that tab and raise its window
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class OoWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

function Get-WtWindows {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
  $AE::RootElement.FindAll($Scope::Children, $c)
}

function Get-Tabs($w) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  @($w.FindAll($Scope::Descendants, $c))
}

function Raise($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ([OoWin]::IsIconic($h)) { [OoWin]::ShowWindow($h, 9) | Out-Null }
  # a synthetic Alt tap lifts the foreground lock so SetForegroundWindow is honoured
  [OoWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [OoWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [OoWin]::SetForegroundWindow($h) | Out-Null
}

function Reply($obj) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $obj)); [Console]::Out.Flush() }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $req = $line | ConvertFrom-Json
    $wins = @(Get-WtWindows)
    if ($req.op -eq 'tabs') {
      $out = @()
      foreach ($w in $wins) {
        $i = 0
        foreach ($t in Get-Tabs $w) { $out += @{ window = $w.Current.NativeWindowHandle; index = $i; name = $t.Current.Name }; $i++ }
      }
      Reply @{ ok = $true; tabs = $out }
    }
    elseif ($req.op -eq 'focus') {
      $hit = $null; $hitWin = $null
      foreach ($w in $wins) {
        foreach ($t in Get-Tabs $w) {
          if (-not $hit -and $req.tab -and $t.Current.Name -match $req.tab) { $hit = $t; $hitWin = $w }
        }
      }
      if (-not $hit -and $null -ne $req.index -and $wins.Count -gt 0) {
        $tabs = Get-Tabs $wins[0]
        if ($req.index -lt $tabs.Count) { $hit = $tabs[$req.index]; $hitWin = $wins[0] }
      }
      if (-not $hit) {
        # Fullscreen (or a single tab) hides the tab row, so there are no tabs to find. Ask
        # Windows Terminal itself to switch to the host's tab by position, after raising
        # the window so it's the one `-w 0` (most recently used) means.
        $bare = @($wins | Where-Object { (Get-Tabs $_).Count -eq 0 })
        if ($bare.Count -gt 0) {
          $w = $bare | Where-Object { $req.tab -and $_.Current.Name -match $req.tab } | Select-Object -First 1
          if ($w) { Raise $w; Reply @{ ok = $true; name = $w.Current.Name; hidden = $true }; continue }
          if ($null -ne $req.index) {
            Raise $bare[0]
            Start-Process wt.exe -ArgumentList '-w', '0', 'focus-tab', '--target', ([int]$req.index) -WindowStyle Hidden
            Reply @{ ok = $true; index = [int]$req.index; hidden = $true }; continue
          }
        }
        Reply @{ ok = $false; error = 'no matching Windows Terminal tab'; windows = $wins.Count }; continue
      }
      $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      Raise $hitWin
      Reply @{ ok = $true; name = $hit.Current.Name }
    }
    elseif ($req.op -eq 'fg') {
      $fg = [OoWin]::GetForegroundWindow().ToInt64()
      $w = $wins | Where-Object { $_.Current.NativeWindowHandle -eq $fg } | Select-Object -First 1
      if (-not $w) { Reply @{ ok = $true; wt = $false }; continue }
      $sel = Get-Tabs $w | Where-Object { $_.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } | Select-Object -First 1
      Reply @{ ok = $true; wt = $true; tab = $(if ($sel) { $sel.Current.Name } elseif ((Get-Tabs $w).Count -eq 0) { $w.Current.Name } else { '' }) }
    }
    else { Reply @{ ok = $false; error = "unknown op $($req.op)" } }
  } catch {
    Reply @{ ok = $false; error = $_.Exception.Message }
  }
}
