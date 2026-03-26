# ═══════════════════════════════════════════════════════════════════════════
#  MSP — Project Scaffold
#  scaffold.ps1
#
#  Creates the complete folder structure for Michie Stream Platform.
#  Run once in an empty root folder:
#
#    cd C:\michie-stream-platform
#    powershell -ExecutionPolicy Bypass -File scaffold.ps1
#
# ═══════════════════════════════════════════════════════════════════════════

$Root = "C:\michie-stream-platform"
$ErrorActionPreference = "Stop"

function New-Dir($rel) {
    $full = Join-Path $Root $rel
    if (-not (Test-Path $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
        Write-Host "  [+] $rel" -ForegroundColor Green
    } else {
        Write-Host "  [=] $rel (exists)" -ForegroundColor DarkGray
    }
}

function New-Placeholder($rel, $content = "") {
    $full = Join-Path $Root $rel
    if (-not (Test-Path $full)) {
        Set-Content -Path $full -Value $content -Encoding UTF8
        Write-Host "  [+] $rel" -ForegroundColor Cyan
    } else {
        Write-Host "  [=] $rel (exists)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "  ║   Michie Stream Platform — Scaffold      ║" -ForegroundColor Yellow
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Yellow
Write-Host ""

# ── Root ────────────────────────────────────────────────────────────────────
Write-Host "Root: $Root" -ForegroundColor White
if (-not (Test-Path $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
}

# ── Directories ─────────────────────────────────────────────────────────────
Write-Host "`n[Directories]" -ForegroundColor Yellow

$dirs = @(
    "public",
    "public\Scripts",
    "public\styles",
    "public\vendor",
    "public\vendor\bootstrap",
    "public\vendor\ethers",
    "public\vendor\hls",
    "public\vendor\ipfs",
    "src",
    "src\python",
    "contracts",
    "infra",
    "infra\scripts",
    "schemas",
    "docs",
    "certs",
    "logs",
    "temp",
    "bin",
    "bin\contracts",
    "examples"
)

foreach ($d in $dirs) { New-Dir $d }

# ── Placeholder files (prevent missing-file errors on first boot) ──────────
Write-Host "`n[Placeholder files]" -ForegroundColor Yellow

# profiles.json — empty object, server loads this on start
New-Placeholder "profiles.json" "{}"

# dj_sets.json
New-Placeholder "dj_sets.json" "{}"

# live_sessions.json
New-Placeholder "live_sessions.json" "{}"

# .gitignore
$gitignore = @"
# Runtime data
profiles.json
dj_sets.json
live_sessions.json

# Environment — NEVER commit
.env

# Media output (served by Nginx, not tracked in Git)
public/live/
public/streams/
temp/

# Node
node_modules/
npm-debug.log*

# Logs
logs/
*.log

# Certs
certs/*.pem
certs/*.key
certs/*.crt

# Windows
Thumbs.db
desktop.ini

# VS Code
.vscode/

# Backups
*.bak
*.bak.*
"@
New-Placeholder ".gitignore" $gitignore

# .env — copy from .env.example, user fills it in
$envNote = @"
# !! Copy .env.example to .env and fill in your values !!
# Run: copy .env.example .env
# Then edit .env with your actual keys and paths.
"@
New-Placeholder ".env" $envNote

# styles.css — blank, add later
New-Placeholder "public\styles\styles.css" "/* MSP Global Styles — SIGNAL Design System */"

# common.js — placeholder
New-Placeholder "public\Scripts\common.js" "// MSP Common — playHls, IPFS gateway helpers"

# script.js — legacy, keep as reference
New-Placeholder "public\Scripts\script.js" "// Legacy — not loaded anywhere. Keep for reference only."

# wallet-boot.js — placeholder
New-Placeholder "public\Scripts\wallet-boot.js" "// Wallet bootstrap helper"

# demucs_script.py placeholder
New-Placeholder "src\python\demucs_script.py" "# Demucs stem separation script — API update pending"

# schemas
$schemas = @(
    "schemas\music.schema.json",
    "schemas\podcast.schema.json",
    "schemas\art.schema.json",
    "schemas\art_animated.schema.json",
    "schemas\art_still.json",
    "schemas\core.schema.json",
    "schemas\music_media_rollup.json"
)
foreach ($s in $schemas) { New-Placeholder $s "{}" }

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✔  Scaffold complete." -ForegroundColor Green
Write-Host "  Next step: run copy-outputs.ps1 to place your built files." -ForegroundColor Cyan
Write-Host ""
