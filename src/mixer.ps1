# Windows volume mixer helper. One long-running process: a line on stdin is a command, the answer is one JSON line on stdout.
#   list               -> {"master":0..100,"muted":bool,"apps":[{"name":"Spotify","vol":0..100,"muted":bool,"active":bool}]}
#   set <name> <0-100> -> volume of every audio session of that program
#   mute <name> <0|1>  -> mute / unmute that program
#   master <0-100>     -> the volume of the whole computer
# The sessions are the ones in the Windows volume mixer (Core Audio). Nothing here leaves the computer.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AtulsMixer {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string s);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string s, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string s);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string s, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid ctx);
    [PreserveSig] int GetMute(out bool mute);
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
    [PreserveSig] int GetChannelCount(out int c);
    [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float db);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid ctx);
    [PreserveSig] int GetMute(out bool mute);
  }

  public class AppVol { public string Name; public float Vol; public bool Muted; public bool Active; }

  public static class Mixer {
    static object Activate(Guid iid) {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
      object o; Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      return o;
    }
    static IAudioEndpointVolume Endpoint() { return (IAudioEndpointVolume)Activate(typeof(IAudioEndpointVolume).GUID); }
    public static float Master() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return v; }
    public static bool MasterMuted() { bool m; Endpoint().GetMute(out m); return m; }
    public static void SetMaster(float v) { Guid g = Guid.Empty; Endpoint().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), ref g); if (v > 0) Endpoint().SetMute(false, ref g); }

    static string NameOf(uint pid) {
      if (pid == 0) return "System sounds";
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
    }
    // every session as (name, volume control, state)
    static List<object[]> Sessions() {
      var list = new List<object[]>();
      var mgr = (IAudioSessionManager2)Activate(typeof(IAudioSessionManager2).GUID);
      IAudioSessionEnumerator en; Marshal.ThrowExceptionForHR(mgr.GetSessionEnumerator(out en));
      int n; en.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 c; if (en.GetSession(i, out c) != 0 || c == null) continue;
        uint pid; c.GetProcessId(out pid);
        int st; c.GetState(out st);
        if (st == 2) continue; // expired
        string name = NameOf(pid); if (name == null) continue;
        list.Add(new object[] { name, (ISimpleAudioVolume)c, st });
      }
      return list;
    }
    public static List<AppVol> Apps() {
      var map = new Dictionary<string, AppVol>(StringComparer.OrdinalIgnoreCase);
      foreach (var s in Sessions()) {
        string name = (string)s[0]; var v = (ISimpleAudioVolume)s[1];
        float vol; bool mute; v.GetMasterVolume(out vol); v.GetMute(out mute);
        AppVol a;
        if (!map.TryGetValue(name, out a)) { a = new AppVol { Name = name, Vol = vol, Muted = mute }; map[name] = a; }
        if ((int)s[2] == 1) a.Active = true;
      }
      return new List<AppVol>(map.Values);
    }
    public static int SetApp(string name, float vol, int mute) {
      int n = 0; Guid g = Guid.Empty;
      foreach (var s in Sessions()) {
        if (!string.Equals((string)s[0], name, StringComparison.OrdinalIgnoreCase)) continue;
        var v = (ISimpleAudioVolume)s[1];
        if (vol >= 0) v.SetMasterVolume(Math.Max(0f, Math.Min(1f, vol)), ref g);
        if (mute >= 0) v.SetMute(mute == 1, ref g);
        n++;
      }
      return n;
    }
  }
}
'@

function Esc([string]$s) { ($s -replace '\\', '\\\\' -replace '"', '\"') }
function Snapshot {
  $apps = foreach ($a in [AtulsMixer.Mixer]::Apps()) { '{"name":"' + (Esc $a.Name) + '","vol":' + [int][math]::Round($a.Vol * 100) + ',"muted":' + $(if ($a.Muted) { 'true' } else { 'false' }) + ',"active":' + $(if ($a.Active) { 'true' } else { 'false' }) + '}' }
  $m = [int][math]::Round([AtulsMixer.Mixer]::Master() * 100)
  '{"master":' + $m + ',"muted":' + $(if ([AtulsMixer.Mixer]::MasterMuted()) { 'true' } else { 'false' }) + ',"apps":[' + ($apps -join ',') + ']}'
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
# ReadLine returns null when the app has gone (the pipe closes), which ends this process
while ($null -ne ($cmd = [Console]::In.ReadLine())) {
  try {
    $p = $cmd.Trim() -split ' ', 3
    switch ($p[0]) {
      'set' { $null = [AtulsMixer.Mixer]::SetApp($p[2], [float]([double]$p[1] / 100), -1) }
      'mute' { $null = [AtulsMixer.Mixer]::SetApp($p[2], -1, [int]$p[1]) }
      'master' { [AtulsMixer.Mixer]::SetMaster([float]([double]$p[1] / 100)) }
    }
    $json = Snapshot
  } catch { $json = '{"error":"' + (Esc $_.Exception.Message) + '"}' }
  [Console]::Out.WriteLine($json); [Console]::Out.Flush()
}
