$exclude = @('.git', 'node_modules', 'dist', 'build', '.svelte-kit', 'coverage', '.vscode', 'playwright-report', 'test-results', 'package-lock.json', 'pnpm-lock.yaml')
$files = Get-ChildItem -File -Recurse | Where-Object {
    $path = $_.FullName
    $skip = $false
    foreach ($ex in $exclude) {
        if ($path -match "\\$ex\\") { $skip = $true; break }
    }
    -not $skip
}

$folderStats = @{}
$extStats = @{}
$total = @{ Files = 0; Lines = 0; SizeKB = 0 }

foreach ($f in $files) {
    $relPath = $f.FullName.Substring($PWD.Path.Length + 1)
    $parts = $relPath -split '\\|/'
    $category = if ($parts.Count -gt 1) { $parts[0] } else { "Root" }
    $ext = if ($f.Extension) { $f.Extension.ToLower() } else { "No Extension" }

    if (-not $folderStats.ContainsKey($category)) { $folderStats[$category] = @{ Files = 0; Lines = 0; SizeKB = 0 } }
    if (-not $extStats.ContainsKey($ext)) { $extStats[$ext] = @{ Files = 0; Lines = 0; SizeKB = 0 } }

    $size = ($f.Length / 1KB)
    $folderStats[$category].Files += 1
    $folderStats[$category].SizeKB += $size
    $extStats[$ext].Files += 1
    $extStats[$ext].SizeKB += $size
    $total.Files += 1
    $total.SizeKB += $size

    $binaries = @('.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.bin', '.elf', '.uf2', '.json', '.lock', '.map')
    if ($ext -notin $binaries) {
        try {
            $lineCount = (Get-Content $f.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
            if ($lineCount) {
                $folderStats[$category].Lines += $lineCount
                $extStats[$ext].Lines += $lineCount
                $total.Lines += $lineCount
            }
        } catch {}
    }
}

Write-Host "--- FOLDER BREAKDOWN ---"
$folderResults = @()
$folderStats.GetEnumerator() | ForEach-Object {
    $folderResults += [PSCustomObject]@{ Folder = $_.Key; Files = $_.Value.Files; Lines = $_.Value.Lines; SizeKB = [math]::Round($_.Value.SizeKB, 2) }
}
$folderResults | Sort-Object SizeKB -Descending | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "--- EXTENSION BREAKDOWN (Top 10 by Lines) ---"
$extResults = @()
$extStats.GetEnumerator() | ForEach-Object {
    $extResults += [PSCustomObject]@{ Extension = $_.Key; Files = $_.Value.Files; Lines = $_.Value.Lines; SizeKB = [math]::Round($_.Value.SizeKB, 2) }
}
$extResults | Sort-Object Lines -Descending | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "--- TOTALS ---"
[PSCustomObject]@{ TotalFiles = $total.Files; TotalLines = $total.Lines; TotalSizeMB = [math]::Round($total.SizeKB / 1024, 2) } | Format-Table -AutoSize | Out-String | Write-Host
