<#
  把 repo 裡給人讀的文件備份到本機 Obsidian（只複製，不會刪 Obsidian 裡的東西）。
  用法：powershell -ExecutionPolicy Bypass -File tools\backup-obsidian.ps1
  第一次用：在 tools\backup.config.json 寫 {"obsidian_dir": "D:\\Obsidian\\我的 vault\\<專案名>"}（這個檔不進 git）
  Notion 的頁面由 AI 用 Notion 連接器另外匯出到同一個資料夾的「Notion」子資料夾。
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$cfgPath = Join-Path $PSScriptRoot "backup.config.json"
if (-not (Test-Path $cfgPath)) { throw "找不到 tools\backup.config.json，請先填 obsidian_dir" }
$dest = (Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).obsidian_dir
if (-not $dest) { throw "backup.config.json 沒有 obsidian_dir" }

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$items = @(
    @{ from = "docs\flow";            to = "開發流" },
    @{ from = "docs\spectra\specs";   to = "規則書" },
    @{ from = "docs\spectra\changes"; to = "申請單" }
)
foreach ($i in $items) {
    $src = Join-Path $root $i.from
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $dest $i.to
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item (Join-Path $src "*") $dst -Recurse -Force
    Write-Host "已備份 $($i.from) → $dst"
}
foreach ($f in @("README.md", "CLAUDE.md")) {
    Copy-Item (Join-Path $root $f) (Join-Path $dest $f) -Force
}
Set-Content (Join-Path $dest "備份時間.md") "最後備份：$stamp`n`n（這個資料夾是備份，請到 Notion 或 GitHub 修改）" -Encoding UTF8
Write-Host "完成：$dest（$stamp）"
