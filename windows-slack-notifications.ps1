# Read only Slack toasts from the current user's Windows notification store.
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SlackToastDb {
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_open_v2(byte[] path, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int length, out IntPtr stmt, IntPtr tail);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_step(IntPtr stmt);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_blob(IntPtr stmt, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_bytes(IntPtr stmt, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern long sqlite3_column_int64(IntPtr stmt, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_finalize(IntPtr stmt);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_close(IntPtr db);

  static byte[] Utf8(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }
  public static List<string[]> Read(string path) {
    var rows = new List<string[]>();
    IntPtr db = IntPtr.Zero, stmt = IntPtr.Zero;
    if (sqlite3_open_v2(Utf8(path), out db, 1, IntPtr.Zero) != 0) throw new Exception("Windows notifications could not be opened.");
    try {
      string sql = "SELECT n.Id,n.ArrivalTime,n.Payload FROM Notification n JOIN NotificationHandler h ON h.RecordId=n.HandlerId WHERE lower(h.PrimaryId) LIKE '%slack%' AND n.PayloadType='Xml' ORDER BY n.ArrivalTime DESC LIMIT 500";
      if (sqlite3_prepare_v2(db, Utf8(sql), -1, out stmt, IntPtr.Zero) != 0) throw new Exception("Windows notifications could not be read.");
      int result;
      while ((result = sqlite3_step(stmt)) == 100) {
        int length = sqlite3_column_bytes(stmt, 2);
        if (length < 1 || length > 50000) continue;
        var bytes = new byte[length];
        Marshal.Copy(sqlite3_column_blob(stmt, 2), bytes, 0, length);
        rows.Add(new string[] { sqlite3_column_int64(stmt, 0).ToString(), sqlite3_column_int64(stmt, 1).ToString(), Encoding.UTF8.GetString(bytes) });
      }
      if (result != 101) throw new Exception("Windows notifications could not be read.");
      return rows;
    } finally { if (stmt != IntPtr.Zero) sqlite3_finalize(stmt); sqlite3_close(db); }
  }
}
'@

$db = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications\wpndatabase.db'
if (-not (Test-Path -LiteralPath $db)) { '[]'; exit 0 }
$events = foreach ($row in [SlackToastDb]::Read($db)) {
  try {
    [xml]$toast = $row[2]
    $link = [uri]$toast.toast.launch
    if ($link.Scheme -ne 'slack' -or $link.Host -ne 'channel') { continue }
    $query = @{}
    foreach ($part in $link.Query.TrimStart('?').Split('&')) {
      $kv = $part.Split('=', 2)
      if ($kv.Length -eq 2) { $query[$kv[0]] = [uri]::UnescapeDataString($kv[1]) }
    }
    if ($query.team -notmatch '^T[A-Z0-9]{4,19}$' -or $query.id -notmatch '^[CGD][A-Z0-9]{4,19}$' -or $query.message -notmatch '^\d{9,11}\.\d+$') { continue }
    $lines = @($toast.toast.visual.binding.text)
    if ($lines.Count -lt 2) { continue }
    [pscustomobject]@{ id = $row[0]; arrival = $row[1]; teamId = $query.team; teamName = [string]$toast.toast.header.title;
      channelId = $query.id; channelName = [string]$lines[0].'#text'; ts = $query.message; text = [string]$lines[1].'#text'; url = [string]$toast.toast.launch }
  } catch { continue }
}
ConvertTo-Json -InputObject @($events) -Depth 4 -Compress
