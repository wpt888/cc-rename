<#
.SYNOPSIS
  Install cc-rename as a global Claude Code UserPromptSubmit hook.
.DESCRIPTION
  Backs up ~/.claude/settings.json, then adds (or refreshes) a hook group under
  hooks.UserPromptSubmit that runs this folder's auto-rename.js. The hook auto-
  names each session from its own conversation. Idempotent — safe to re-run; it
  replaces its own previous entry instead of duplicating it, and leaves every
  other hook (e.g. notifications) untouched.
.PARAMETER Uninstall
  Remove the cc-rename hook group from settings.json (keeps the backup).
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# Write JSON as UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's
# `Set-Content -Encoding utf8` prepends a BOM, which some JSON parsers (and Claude
# Code's settings reader) can choke on. This keeps settings.json clean everywhere.
function Write-JsonNoBom([string]$Path, $Object) {
  $text = $Object | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$autoRenameJs = Join-Path $scriptDir 'auto-rename.js'
if (-not (Test-Path $autoRenameJs)) {
  Write-Error "auto-rename.js not found next to install.ps1 ($autoRenameJs)"
  exit 1
}

$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (-not (Test-Path $settingsPath)) {
  Write-Error "Claude Code settings not found at $settingsPath"
  exit 1
}

# Back up first.
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$settingsPath.cc-rename-backup-$stamp"
Copy-Item $settingsPath $backup
Write-Host "Backed up settings to $backup"

# Forward slashes are valid on Windows and avoid JSON escaping pain.
$cmdPath = ($autoRenameJs -replace '\\', '/')
$command = "node `"$cmdPath`""

$json = Get-Content $settingsPath -Raw | ConvertFrom-Json

# Ensure hooks object exists.
if (-not ($json.PSObject.Properties.Name -contains 'hooks')) {
  $json | Add-Member -MemberType NoteProperty -Name 'hooks' -Value ([PSCustomObject]@{})
}
$hooks = $json.hooks

# Ensure hooks.UserPromptSubmit is an array.
if (-not ($hooks.PSObject.Properties.Name -contains 'UserPromptSubmit')) {
  $hooks | Add-Member -MemberType NoteProperty -Name 'UserPromptSubmit' -Value @()
}

# Drop any prior cc-rename group (match on auto-rename.js) so re-runs don't stack.
$kept = @()
foreach ($group in @($hooks.UserPromptSubmit)) {
  $isOurs = $false
  foreach ($h in @($group.hooks)) {
    if ($h.command -and ($h.command -match 'auto-rename\.js')) { $isOurs = $true }
  }
  if (-not $isOurs) { $kept += $group }
}

if ($Uninstall) {
  $hooks.UserPromptSubmit = @($kept)
  Write-JsonNoBom $settingsPath $json
  Write-Host "cc-rename hook removed. Start a new Claude Code session to apply."
  exit 0
}

# Append our group.
$ourGroup = [PSCustomObject]@{
  hooks = @(
    [PSCustomObject]@{
      type    = 'command'
      command = $command
      timeout = 30
    }
  )
}
$hooks.UserPromptSubmit = @($kept) + $ourGroup

Write-JsonNoBom $settingsPath $json
Write-Host "cc-rename installed. Start a new Claude Code session to activate."
Write-Host "Command: $command"
Write-Host "Debug:   set CC_RENAME_DEBUG=1 to trace to ~/.claude/cc-rename.log"
