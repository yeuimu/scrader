# pmclick.ps1 — PostMessage 鼠标点击兜底（cua/click 在 Chromium 网页内容上只留 hover 不触发时用）
# 用法：
#   像素点击：pmclick.ps1 -Hwnd <窗口hwnd> -X <客户区x> -Y <客户区y>
#   按钮点击：pmclick.ps1 -Hwnd <对话框hwnd> -Caption "选择文件夹"   （BM_CLICK，对标准 Win32 按钮最可靠）
# 坐标来源：cua get_window_state 的 element frame（即窗口客户区坐标，窗口位于 (0,0) 时等于屏幕坐标）。
# 本文件必须保持 UTF-8 with BOM。
param(
  [int]$Hwnd = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Caption = ""
)
if (-not $Hwnd) { Write-Output "需要 -Hwnd（find_window / get_window_state 的 window_id，即 Win32 hwnd）"; exit 1 }
Add-Type 'using System; using System.Runtime.InteropServices; using System.Text; public class PMK {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}'
$dlg = [IntPtr]$Hwnd
[void][PMK]::SetForegroundWindow($dlg)
Start-Sleep -Milliseconds 150

if ($Caption) {
  $after = [IntPtr]::Zero; $found = [IntPtr]::Zero
  while ($true) {
    $c = [PMK]::FindWindowEx($dlg, $after, $null, $null)
    if ($c -eq [IntPtr]::Zero) { break }
    $sb = New-Object System.Text.StringBuilder 256
    [void][PMK]::GetWindowText($c, $sb, 256)
    if ($sb.ToString() -eq $Caption) { $found = $c; break }
    $after = $c
  }
  if ($found -ne [IntPtr]::Zero) {
    [void][PMK]::PostMessage($found, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
    Write-Output "BM_CLICK -> '$Caption' (hwnd=$found)"
  } else { Write-Output "未找到按钮: $Caption"; exit 2 }
} else {
  $lp = [IntPtr](($X) -bor ($Y -shl 16))
  [void][PMK]::PostMessage($dlg, 0x0200, [IntPtr]::Zero, $lp)  # WM_MOUSEMOVE
  Start-Sleep -Milliseconds 60
  [void][PMK]::PostMessage($dlg, 0x0201, [IntPtr]1, $lp)       # WM_LBUTTONDOWN
  Start-Sleep -Milliseconds 50
  [void][PMK]::PostMessage($dlg, 0x0202, [IntPtr]::Zero, $lp)  # WM_LBUTTONUP
  Write-Output "click -> hwnd=$Hwnd ($X,$Y)"
}
