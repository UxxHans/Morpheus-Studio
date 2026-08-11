using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace BeatMapStudio.Services;

/// <summary>
/// Minimal JSON-RPC-style bridge over WebView2's postMessage/PostWebMessageAsJson.
/// JS sends {id, method, params}; this replies with {id, result} or {id, error}.
/// Matches the client-side wrapper in wwwroot/js/bridge.js.
/// </summary>
public class Bridge
{
    private readonly CoreWebView2 _webView;
    private readonly SongLibraryService _library;
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public Bridge(CoreWebView2 webView, SongLibraryService library)
    {
        _webView = webView;
        _library = library;
        _webView.WebMessageReceived += OnMessage;
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json = e.WebMessageAsJson;
        string id = "";
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetString() ?? "";
            string method = root.GetProperty("method").GetString() ?? "";
            JsonElement p = root.TryGetProperty("params", out var pv) ? pv : default;

            object? result = await Dispatch(method, p);
            Reply(id, result, null);
        }
        catch (Exception ex)
        {
            Reply(id, null, ex.Message);
        }
    }

    private void Reply(string id, object? result, string? error)
    {
        var payload = new Dictionary<string, object?> { ["id"] = id };
        if (error != null) payload["error"] = error;
        else payload["result"] = result;
        _webView.PostWebMessageAsJson(JsonSerializer.Serialize(payload, JsonOpts));
    }

    private Task<object?> Dispatch(string method, JsonElement p)
    {
        switch (method)
        {
            case "scanSongs":
                return Task.FromResult<object?>(_library.ScanSongs());

            case "createSong":
                return Task.FromResult<object?>(_library.CreateSong());

            case "deleteSong":
                _library.DeleteSong(Str(p, "folder"));
                return Task.FromResult<object?>(true);

            case "renameSong":
                return Task.FromResult<object?>(_library.RenameSong(Str(p, "folder"), Str(p, "title")));

            case "setTrackCount":
                return Task.FromResult<object?>(_library.SetTrackCount(Str(p, "folder"), Int(p, "trackCount")));

            case "setSubtitle":
                return Task.FromResult<object?>(_library.SetSubtitle(Str(p, "folder"), Str(p, "subtitle")));

            case "importAudio":
                return Task.FromResult<object?>(_library.ImportAudio(
                    Str(p, "folder"), Str(p, "sourcePath"), Str(p, "title"), Int(p, "trackCount")));

            case "importCover":
                return Task.FromResult<object?>(_library.ImportCover(
                    Str(p, "folder"), Str(p, "sourcePath"), Str(p, "subtitle")));

            case "loadChart":
                return Task.FromResult<object?>(_library.LoadChart(Str(p, "folder"), Str(p, "difficulty")));

            case "saveChart":
                return Task.FromResult<object?>(_library.SaveChart(
                    Str(p, "folder"), Str(p, "difficulty"), Int(p, "rate"), Str(p, "csv")));

            case "pickAudioFile":
                return Task.FromResult<object?>(PickFile("Audio Files|*.mp3;*.wav"));

            case "pickImageFile":
                return Task.FromResult<object?>(PickFile("Image Files|*.jpg;*.jpeg;*.png"));

            case "revealFolder":
                RevealFolder(Str(p, "folder"));
                return Task.FromResult<object?>(true);

            default:
                throw new InvalidOperationException("Unknown method: " + method);
        }
    }

    private string? PickFile(string filter)
    {
        var dlg = new OpenFileDialog { Filter = filter, CheckFileExists = true };
        return dlg.ShowDialog() == true ? dlg.FileName : null;
    }

    private void RevealFolder(string folder)
    {
        string path = Path.Combine(_library.Root, folder);
        if (!Directory.Exists(path)) return;
        // Explorer itself can take a moment to spawn a window, but that shouldn't hold up
        // this bridge call's response — fire it on a background thread so Dispatch returns
        // to the UI right away instead of the click feeling delayed waiting on it.
        Task.Run(() =>
        {
            try { Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true }); }
            catch { /* best-effort — nothing meaningful to surface back to the UI here */ }
        });
    }

    private static string Str(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) ? v.GetString() ?? "" : "";

    private static int Int(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) ? v.GetInt32() : 0;
}
