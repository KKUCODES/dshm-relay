param(
    [Parameter(Mandatory = $true)][ValidateSet('snapshot', 'opened', 'revealed', 'cleanup')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$FilePath
)
$ErrorActionPreference = 'Stop'
$taskFile = [IO.Path]::GetFullPath($FilePath)
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../plugin/artifacts/official-dsh-alpha2/home/official-remote-test-project'))
if (!$taskFile.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Outside owned test project' }
$taskRelative = $taskFile.Substring($taskRoot.Length + 1)
if ($taskRelative -notmatch '^([a-f0-9]{8})\\dshm-official-\1\.txt$') { throw 'Unexpected test filename' }
$taskName = [IO.Path]::GetFileName($taskFile)
$taskFolder = [IO.Path]::GetDirectoryName($taskFile)
$taskShell = New-Object -ComObject Shell.Application
function Get-OwnedExplorer {
    @($taskShell.Windows()) | Where-Object {
        try { [string]$_.Document.Folder.Self.Path -eq $taskFolder } catch { $false }
    }
}
function Get-OwnedNotepad {
    @(Get-Process -Name notepad -ErrorAction SilentlyContinue) | Where-Object {
        $_.MainWindowTitle.Contains($taskName, [StringComparison]::OrdinalIgnoreCase)
    }
}
if ($Mode -eq 'snapshot') {
    $taskNotepads = @(Get-Process -Name notepad -ErrorAction SilentlyContinue)
    if ($taskNotepads.Count -ne 0) { throw 'Existing Notepad must be preserved; refusing native open test' }
    if (@(Get-OwnedExplorer).Count -ne 0) { throw 'Existing test-folder window must be preserved' }
    @{ notepadAbsent = $true; explorerHandles = @($taskShell.Windows() | ForEach-Object { [long]$_.HWND }) } | ConvertTo-Json -Compress
    exit 0
}
if ($Mode -eq 'opened') {
    $taskMatches = @(Get-OwnedNotepad)
    if ($taskMatches.Count -ne 1) { throw 'Expected exactly one actual test-file Notepad window' }
    $taskProcess = $taskMatches[0]
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $taskWindow = [System.Windows.Automation.AutomationElement]::FromHandle($taskProcess.MainWindowHandle)
    $taskTabs = $taskWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)))
    if ($taskTabs.Count -gt 1) { throw 'Refusing to close a window containing other documents' }
    $taskElements = $taskWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree,
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true))
    $taskExpected = [IO.File]::ReadAllText($taskFile).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
    $taskMatched = $false
    $taskLengths = @()
    foreach ($taskElement in $taskElements) {
        $taskPattern = $null
        if ($taskElement.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$taskPattern)) {
            $taskRaw = $taskPattern.DocumentRange.GetText(-1)
            $taskText = $taskRaw.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
            $taskLengths += $taskText.Length
            if ($taskText -eq $taskExpected) {
                $taskMatched = $true
                $taskLineEndings = @{ carriageReturns = ($taskRaw.ToCharArray() | Where-Object { $_ -eq "`r" }).Count;
                    lineFeeds = ($taskRaw.ToCharArray() | Where-Object { $_ -eq "`n" }).Count }
                break
            }
        }
    }
    if (!$taskMatched) { throw "Actual document mismatch: expectedLength=$($taskExpected.Length); patternLengths=$($taskLengths -join ',')" }
    $taskHandle = [long]$taskProcess.MainWindowHandle
    if (!$taskProcess.CloseMainWindow()) { throw 'Could not close owned test-file window' }
    @{ actualDefaultApplication = 'notepad'; pid = $taskProcess.Id; window = $taskHandle;
        documentMatched = $true; soleDocumentVerified = $true; closeRequested = $true; nativeLineEndings = $taskLineEndings } | ConvertTo-Json -Compress
    exit 0
}
if ($Mode -eq 'revealed') {
    $taskMatches = @(Get-OwnedExplorer)
    if ($taskMatches.Count -ne 1) { throw 'Expected exactly one actual Explorer test-folder window' }
    $taskWindow = $taskMatches[0]
    $taskSelection = @($taskWindow.Document.SelectedItems() | ForEach-Object { [string]$_.Path })
    if ($taskSelection.Count -ne 1 -or $taskSelection[0] -ne $taskFile) { throw 'Explorer did not select the test file' }
    $taskHandle = [long]$taskWindow.HWND
    $taskWindow.Quit()
    @{ actualFileManager = 'explorer'; window = $taskHandle; originalFileSelected = $true; closeRequested = $true } | ConvertTo-Json -Compress
    exit 0
}
# 清理仅作用于路径和窗口标题都属于本轮的资源；不停止Explorer或任何已有编辑器进程。
foreach ($taskWindow in @(Get-OwnedExplorer)) { $taskWindow.Quit() }
foreach ($taskProcess in @(Get-OwnedNotepad)) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $taskWindow = [System.Windows.Automation.AutomationElement]::FromHandle($taskProcess.MainWindowHandle)
    $taskTabs = $taskWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)))
    if ($taskTabs.Count -gt 1) { throw 'Refusing cleanup of additional documents' }
    if (!$taskProcess.CloseMainWindow()) { throw 'Could not close owned Notepad' }
}
@{ ownedExplorerWindows = @(Get-OwnedExplorer).Count; ownedNotepadWindows = @(Get-OwnedNotepad).Count;
    explorerHandles = @($taskShell.Windows() | ForEach-Object { [long]$_.HWND }) } | ConvertTo-Json -Compress
