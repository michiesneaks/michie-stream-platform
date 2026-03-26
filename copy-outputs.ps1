param(
    [string]$From = "$env:USERPROFILE\Downloads\msp-outputs",
    [string]$Root = "C:\michie-stream-platform"
)

$ErrorActionPreference = "Continue"

function Copy-MSPFile($src, $dst) {
    $srcFull = Join-Path $From $src
    $dstFull = Join-Path $Root $dst
    $dstDir  = Split-Path $dstFull -Parent

    if (-not (Test-Path $srcFull)) {
        Write-Host "  [!] MISSING: $src" -ForegroundColor Red
        Write-Host "      Expected at: $srcFull" -ForegroundColor DarkRed
        return
    }

    if (-not (Test-Path $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }

    Copy-Item -Path $srcFull -Destination $dstFull -Force
    Write-Host "  [OK] $src" -ForegroundColor Green
    Write-Host "       -> $dst" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  MSP -- Copy Output Files to Project" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source : $From"
Write-Host "  Target : $Root"
Write-Host ""

if (-not (Test-Path $From)) {
    Write-Host "  ERROR: Source folder not found: $From" -ForegroundColor Red
    Write-Host "  Create it, place your downloaded files inside, then re-run." -ForegroundColor Yellow
    exit 1
}

Write-Host "[HTML Pages]" -ForegroundColor Yellow
Copy-MSPFile "index.html"       "public\index.html"
Copy-MSPFile "listen.html"      "public\listen.html"
Copy-MSPFile "creators.html"    "public\creators.html"
Copy-MSPFile "marketplace.html" "public\marketplace.html"
Copy-MSPFile "profile.html"     "public\profile.html"
Copy-MSPFile "live_ui.html"     "public\live_studio.html"

Write-Host ""
Write-Host "[Browser Scripts]" -ForegroundColor Yellow
Copy-MSPFile "main.js"           "public\Scripts\main.js"
Copy-MSPFile "wallets.js"        "public\Scripts\wallets.js"
Copy-MSPFile "router.js"         "public\Scripts\router.js"
Copy-MSPFile "live_broadcast.js" "public\Scripts\live_broadcast.js"

Write-Host ""
Write-Host "[Server]" -ForegroundColor Yellow
Copy-MSPFile "server.cjs"              "src\server.cjs"
Copy-MSPFile "validator.js"            "src\validator.js"
Copy-MSPFile "gst_pipeline.js"         "src\gst_pipeline.js"
Copy-MSPFile "server_gst_additions.js" "src\server_gst_additions.js"
Copy-MSPFile "server_live.js"          "src\server_live.js"

Write-Host ""
Write-Host "[Infrastructure]" -ForegroundColor Yellow
Copy-MSPFile "nginx.conf"            "infra\nginx.conf"
Copy-MSPFile "install-media.sh"      "infra\install-media.sh"
Copy-MSPFile "gst-transcode.sh"      "infra\scripts\gst-transcode.sh"
Copy-MSPFile "gst-transcode-done.sh" "infra\scripts\gst-transcode-done.sh"

Write-Host ""
Write-Host "[Docs]" -ForegroundColor Yellow
Copy-MSPFile "README.md"                               "README.md"
Copy-MSPFile "MSP_Design_System.html"                  "docs\MSP_Design_System.html"
Copy-MSPFile "MSP_Technical_Overview.docx"             "docs\MSP_Technical_Overview.docx"
Copy-MSPFile "MSP_File_Tree_GitHub.docx"               "docs\MSP_File_Tree_GitHub.docx"
Copy-MSPFile "FEATURE_SPEC_Favorites_and_Playlists.md" "docs\FEATURE_SPEC_Favorites_and_Playlists.md"

Write-Host ""
Write-Host "[Root config]" -ForegroundColor Yellow
Copy-MSPFile "package.json" "package.json"
Copy-MSPFile ".env.example" ".env.example"

Write-Host ""
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host "  Copy these manually from your OLD project:" -ForegroundColor Yellow
Write-Host "    contracts\  (all .sol files)"
Write-Host "    public\vendor\  (bootstrap, ethers, hls, ipfs)"
Write-Host "    src\module_aws.js"
Write-Host "    public\Scripts\common.js"
Write-Host "    public\Scripts\wallet-boot.js"
Write-Host "    public\styles\styles.css"
Write-Host ""
Write-Host "  FFmpeg: update FFMPEG_PATH in .env to your existing path."
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Done. Next steps:" -ForegroundColor Green
Write-Host "    cd C:\michie-stream-platform"
Write-Host "    npm install"
Write-Host "    copy .env.example .env"
Write-Host "    npm run dev"
Write-Host ""
