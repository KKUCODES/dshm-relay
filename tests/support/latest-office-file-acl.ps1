param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][ValidateSet('capture', 'deny', 'restore')][string]$Action
)
$ErrorActionPreference = 'Stop'
$fixtureRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../plugin/artifacts/latest-runtime-check/relay-homes')).Path
$target = (Resolve-Path -LiteralPath $FilePath).Path
$relative = [IO.Path]::GetRelativePath($fixtureRoot, $target).Replace('\', '/')
if ($relative -notmatch '^[0-9a-f-]{36}/test-project/latest-(office-transmission|mobile-inflight)\.docx$') {
  throw 'office_acl_outside_owned_fixture'
}
$item = Get-Item -LiteralPath $target
if ($item.PSIsContainer -or $item.LinkType) { throw 'office_acl_requires_regular_fixture' }
$backupPath = $target + '.dshm-acl.json'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$section = [Security.AccessControl.AccessControlSections]::Access
$acl = Get-Acl -LiteralPath $target
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshmOfficeAclNative {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetFileSecurityW(string path, uint information, IntPtr descriptor);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@
if ($Action -eq 'capture') {
  # 在任何 ACL 写入前保存原 DACL；不覆盖可能需要恢复的旧备份。
  $state = @{ path = $target; sid = $sid; sddl = $acl.GetSecurityDescriptorSddlForm($section); restored = $false }
  $stream = [IO.File]::Open($backupPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Compress))
    $stream.Write($bytes, 0, $bytes.Length)
  } finally { $stream.Dispose() }
} else {
  $state = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
  if ($state.path -cne $target -or $state.sid -cne $sid) { throw 'office_acl_backup_identity_mismatch' }
  if ($Action -eq 'deny') {
    if ($state.restored) { throw 'office_acl_already_restored' }
    if ($acl.GetSecurityDescriptorSddlForm($section) -cne $state.sddl) { throw 'office_acl_changed_before_deny' }
    # 仅拒绝文件数据读取；保留读取/修改 DACL 的能力，确保原权限可恢复。
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid),
      [Security.AccessControl.FileSystemRights]::ReadData,
      [Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $target -AclObject $acl
  } else {
    $acl.SetSecurityDescriptorSddlForm($state.sddl, $section)
    Set-Acl -LiteralPath $target -AclObject $acl
    # Set-Acl 对旧继承模型会增加 AI 控制位。只对原无 AI 的描述符按原 Win32 文件接口恢复。
    if ($state.sddl -notmatch '^D:[^\(]*AI') {
      $descriptor = [IntPtr]::Zero
      $size = [uint32]0
      if (-not [DshmOfficeAclNative]::ConvertStringSecurityDescriptorToSecurityDescriptorW($state.sddl, 1, [ref]$descriptor, [ref]$size)) {
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
      }
      try {
        if (-not [DshmOfficeAclNative]::SetFileSecurityW($target, 4, $descriptor)) {
          throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
      } finally { [void][DshmOfficeAclNative]::LocalFree($descriptor) }
    }
    if ((Get-Acl -LiteralPath $target).GetSecurityDescriptorSddlForm($section) -cne $state.sddl) {
      throw 'office_acl_restore_mismatch'
    }
    $state.restored = $true
    [IO.File]::WriteAllText($backupPath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  }
}
$current = (Get-Acl -LiteralPath $target).GetSecurityDescriptorSddlForm($section)
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($current))).ToLowerInvariant()
@{ action = $Action; aclHash = $hash; restored = ($Action -eq 'restore') } | ConvertTo-Json -Compress
