# Starts the synthetic feeder simulator for one device against the development project.
# Simulator data only: not hardware evidence, no GPIO. Stop it with Ctrl+C.
param(
  [string]$SecretsDir = $PSScriptRoot,
  [string]$DeviceId = "22222222-2222-4222-8222-222222222222",
  [string]$JournalDir = $PSScriptRoot,
  [ValidateRange(0, 24)][int]$BackfillHours = 0,
  [string]$Scenario = "normal",
  [string]$TelemetryScenario = "valid"
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot

$envFile = Join-Path $repoRoot ".env.local"
if (-not (Test-Path -LiteralPath $envFile)) {
  throw ".env.local was not found at $envFile. Keep the bundled configuration beside this launcher."
}
$values = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
    $values[$Matches[1]] = $Matches[2].Trim('"', "'")
  }
}
if (-not $values["EXPO_PUBLIC_SUPABASE_URL"]) { throw "EXPO_PUBLIC_SUPABASE_URL is missing from .env.local." }
if (-not $values["EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) { throw "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing from .env.local." }
$env:SUPABASE_URL = $values["EXPO_PUBLIC_SUPABASE_URL"]
$env:SUPABASE_PUBLISHABLE_KEY = $values["EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]

$credentialFile = Join-Path $SecretsDir "device-$DeviceId-credential.json"
if (-not (Test-Path -LiteralPath $credentialFile)) {
  throw "No credential file for device $DeviceId in $SecretsDir (expected device-$DeviceId-credential.json)."
}

New-Item -ItemType Directory -Force -Path $JournalDir | Out-Null
$journalFile = Join-Path $JournalDir "demo-$DeviceId.sqlite3"

$arguments = @(
  (Join-Path $repoRoot "art31_simulator.py"),
  "--device-id", $DeviceId,
  "--credential-file", $credentialFile,
  "--db", $journalFile,
  "--scenario", $Scenario,
  "--telemetry-scenario", $TelemetryScenario
)
if ($BackfillHours -gt 0) { $arguments += @("--backfill-hours", "$BackfillHours") }

& python @arguments
