# Screen geometry probe for the Snug SQL Formatter extension.
#
# ASCII only on purpose: PowerShell 5.1 reads BOM-less script files as ANSI,
# so non-ASCII comments would be garbled and can break parsing.
#
# Output, single line, pipe separated:
#   <maxMonitorWidthPx>|<monitorCount>
#
# Design notes
#
# 1) No SetProcessDPIAware call.
#    Without it Windows virtualizes coordinates to 96 DPI, so
#    Screen.Bounds.Width is reported in the same CSS pixel space the editor
#    lays out in. Making the process DPI aware and then dividing by the scale
#    factor is exactly how the old code produced a width twice too large.
#
# 2) Multi monitor: the WIDEST screen wins, as requested ("multi monitor:
#    judge against the highest-resolution screen"), so long statements can be
#    laid out for the big display.
#
# 3) No runtime C# compilation.
#    Add-Type -TypeDefinition costs about a second on its own, and this script
#    runs while the extension host is still starting up, competing with every
#    other extension. The old probe was an inline -Command with a 4 s timeout;
#    under that contention it was killed every single time, silently fell back
#    to the 200-column default, and the user's formatting width was never
#    actually derived from the screen. Keeping the script small and free of
#    P/Invoke is what makes the 20 s budget comfortable instead of marginal.

$ErrorActionPreference = 'SilentlyContinue'

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
} catch {
    Write-Output '0|0'
    exit 0
}

$maxWidth = 0
$count = 0
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $count++
    $w = [int]$screen.Bounds.Width
    if ($w -gt $maxWidth) { $maxWidth = $w }
}

Write-Output ("{0}|{1}" -f $maxWidth, $count)
