# Arrow-key menu for run.bat: Up/Down to move, Enter to confirm, or press the option's digit.
# Exits with the chosen option's number (0 = Exit), which run.bat reads from %errorlevel%.

$options = @(
    @{ Key = 1; Label = '1)  Start       Install deps, start server, open browser' },
    @{ Key = 2; Label = '2)  Stop        Stop the running server' },
    @{ Key = 3; Label = '3)  Update git  Pull latest from GitHub (requires git)' },
    @{ Key = 4; Label = '4)  Update zip  Download latest release zip from GitHub' },
    @{ Key = 0; Label = '0)  Exit' }
)

# Writes one row at a fixed position in a single call, cut or padded to the window width so
# nothing wraps or leaves stale characters behind.
function Write-Row([int]$Row, [string]$Text, [bool]$Selected) {
    $w = [Console]::WindowWidth - 1
    $t = if ($Text.Length -gt $w) { $Text.Substring(0, $w) } else { $Text.PadRight($w) }
    [Console]::SetCursorPosition(0, $Row)
    if ($Selected) { Write-Host $t -ForegroundColor Black -BackgroundColor Cyan -NoNewline } else { Write-Host $t -NoNewline }
}

function Write-Option([int]$Index) {
    $selected = $Index -eq $sel
    $prefix = if ($selected) { '  > ' } else { '    ' }
    Write-Row ($top + $Index) ($prefix + $options[$Index].Label) $selected
}

Write-Host '  Use Up/Down and Enter, or press a number' -ForegroundColor DarkGray
Write-Host ''
# Reserve the rows first: printing them at the bottom of the window scrolls the buffer, so the
# list's top row is only known after that.
for ($i = 0; $i -lt $options.Count; $i++) { Write-Host '' }
$top = [Console]::CursorTop - $options.Count

$sel = 0
$done = $false
[Console]::CursorVisible = $false
[Console]::TreatControlCAsInput = $true
try {
    for ($i = 0; $i -lt $options.Count; $i++) { Write-Option $i }
    while (-not $done) {
        $prev = $sel
        $k = [Console]::ReadKey($true)
        if ($k.Key -eq 'UpArrow') { $sel = ($sel - 1 + $options.Count) % $options.Count }
        elseif ($k.Key -eq 'DownArrow') { $sel = ($sel + 1) % $options.Count }
        elseif ($k.Key -eq 'Enter') { $done = $true }
        elseif ($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control)) {
            $sel = $options.Count - 1
            $done = $true
        } else {
            for ($i = 0; $i -lt $options.Count; $i++) {
                if ([string]$options[$i].Key -eq [string]$k.KeyChar) { $sel = $i; $done = $true }
            }
        }
        # Only the two rows that change are redrawn.
        if ($sel -ne $prev) {
            Write-Option $prev
            Write-Option $sel
        }
    }
} finally {
    [Console]::SetCursorPosition(0, $top + $options.Count)
    [Console]::CursorVisible = $true
    [Console]::TreatControlCAsInput = $false
}

exit $options[$sel].Key
