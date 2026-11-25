param(
    [Parameter(Mandatory = $true)][string]$Jsx,
    [switch]$Fresh,
    [switch]$Keep

)

# Runs a .jsx file inside the live InDesign instance through COM.
# ExtendScript reads a UTF-8 file WITHOUT a byte-order mark using the system
# code page (GBK here), which mangles Japanese/Chinese text literals and can
# swallow a quote -> "Object reference not set". So every script is re-emitted
# as UTF-8 with BOM into %TEMP% before being evaluated.
$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Jsx).Path

$id = New-Object -ComObject 'InDesign.Application.2025'
if ($null -eq $id) { throw 'InDesign COM object not available' }
try { $id.Visible = $true } catch { }

if ($Fresh) {
    while ($id.Documents.Count -gt 0) { $id.Documents[1].Close($false) }
}

$text = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
$tmp = Join-Path $env:TEMP ('balloonist-run-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.jsx')
[System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($true)))
if (-not $Keep) { $script:tmpToDelete = $tmp }

# DoScript turns any JS exception into a bare COM NullReferenceException, so the
# wrapper catches it inside ExtendScript and returns the real message + line.
$p = $tmp.Replace('\', '/')
$boot = '(function () { try { $.evalFile(new File("' + $p + '")); return "OK"; } catch (e) { return "ERR " + e.name + ": " + e.message + " @line " + e.line; } })()'
Write-Host "DoScript -> $full"
try {
    $res = $id.DoScript($boot, 1246973031)
    Write-Host ("result: " + $res)
}
finally {
    if (-not $Keep -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force }
}
