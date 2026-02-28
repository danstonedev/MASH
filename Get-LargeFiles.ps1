$exclude = @('.git', 'node_modules', 'dist', 'build', '.svelte-kit', 'coverage', '.vscode', 'playwright-report', 'test-results', 'package-lock.json', 'pnpm-lock.yaml')
$binaries = @('.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.bin', '.elf', '.uf2', '.json', '.lock', '.map', '.glb', '.gltf', '.txt', '.log')

$files = Get-ChildItem -File -Recurse | Where-Object {
    $path = $_.FullName
    $skip = $false
    foreach ($ex in $exclude) {
        if ($path -match "\\$ex\\") { $skip = $true; break }
    }
    if ($_.Extension -in $binaries) { $skip = $true }
    -not $skip
}

$largeFiles = @()

foreach ($f in $files) {
    try {
        $lineCount = (Get-Content $f.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
        if ($lineCount -gt 500) {
            $relPath = $f.FullName.Substring($PWD.Path.Length + 1)
            $largeFiles += [PSCustomObject]@{
                File = $relPath
                Lines = $lineCount
                SizeKB = [math]::Round($f.Length / 1KB, 2)
            }
        }
    } catch {}
}

Write-Host "--- FILES OVER 500 LINES ---"
$largeFiles | Sort-Object Lines -Descending | Format-Table -AutoSize | Out-String | Write-Host
