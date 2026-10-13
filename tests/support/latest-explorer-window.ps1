param(
  [Parameter(Mandatory=$true)][string]$WorkspacePath,
  [ValidateSet('inspect', 'close')][string]$Action = 'inspect',
  [long]$WindowHandle = 0
)
$ErrorActionPreference = 'Stop'
# Only the fresh test workspace is observable/closable; never enumerate user paths into reports.
$testRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../plugin/artifacts/latest-runtime-check/relay-homes'))
$target = [IO.Path]::GetFullPath($WorkspacePath).TrimEnd('\')
$prefix = $testRoot.TrimEnd('\') + '\'
if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'explorer_workspace_outside_fixture' }
$local = $target.Substring($prefix.Length)
if ($local -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\test-project$') {
  throw 'explorer_workspace_unknown_fixture'
}
if (!(Test-Path -LiteralPath $target -PathType Container)) { throw 'explorer_workspace_missing' }
$shell = New-Object -ComObject Shell.Application
$found = @()
$handles = @()
foreach ($window in @($shell.Windows())) {
  try {
    if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
    $handles += [long]$window.HWND
    $path = [IO.Path]::GetFullPath($window.Document.Folder.Self.Path).TrimEnd('\')
    if (!$path.Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
      if ($Action -eq 'close' -and [long]$window.HWND -eq $WindowHandle) { throw 'explorer_window_changed_do_not_close' }
      continue
    }
    $found += [pscustomobject]@{ hwnd = [long]$window.HWND; path = $path; application = 'explorer.exe' }
    if ($Action -eq 'close' -and [long]$window.HWND -eq $WindowHandle) { $window.Quit() }
  } catch {
    # Non-filesystem shell windows have no folder path; do not operate on them.
    if ($Action -eq 'close' -and [long]$window.HWND -eq $WindowHandle) { throw }
  }
}
if ($Action -eq 'close' -and $WindowHandle -le 0) { throw 'explorer_close_requires_observed_handle' }
[pscustomobject]@{ windows = @($found); windowHandles = @($handles) } | ConvertTo-Json -Depth 4 -Compress
