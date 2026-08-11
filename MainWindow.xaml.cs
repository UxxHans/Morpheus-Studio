using System.IO;
using System.Reflection;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using BeatMapStudio.Services;

namespace BeatMapStudio;

public partial class MainWindow : Window
{
    public const string AppHost = "app.local";
    public const string MediaHost = "media.local";
    private const string ResourcePrefix = "BeatMapStudio.wwwroot.";

    private Bridge? _bridge;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        string baseDir = AppContext.BaseDirectory;
        string libraryRoot = Path.Combine(baseDir, "CustomMusicCollection");
        Directory.CreateDirectory(libraryRoot);

        string userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "BeatMapStudio", "WebView2");
        Directory.CreateDirectory(userDataFolder);

        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        await Web.EnsureCoreWebView2Async(env);

#if DEBUG
        // Dev convenience: if the live source wwwroot is present on this machine, serve
        // straight from disk instead of the embedded copy — edit a .js/.css file, hit
        // Ctrl+R in the running window, see it immediately, no rebuild needed. Release
        // builds never take this path (and a Debug build on any other machine just falls
        // through to the normal embedded-resource path below).
        string devWwwroot = @"C:\Users\xiaohan\Desktop\BeatMapStudio\wwwroot";
        if (Directory.Exists(devWwwroot))
        {
            Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                AppHost, devWwwroot, CoreWebView2HostResourceAccessKind.Allow);
        }
        else
#endif
        {
            // Front-end is embedded in the assembly (no wwwroot folder on disk) — serve it
            // from memory for the app.local virtual host instead of mapping a real folder.
            Web.CoreWebView2.AddWebResourceRequestedFilter($"https://{AppHost}/*", CoreWebView2WebResourceContext.All);
            Web.CoreWebView2.WebResourceRequested += OnAppResourceRequested;
        }

        Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
            MediaHost, libraryRoot, CoreWebView2HostResourceAccessKind.Allow);

        var library = new SongLibraryService(libraryRoot, MediaHost);
        _bridge = new Bridge(Web.CoreWebView2, library);

        Web.CoreWebView2.Navigate($"https://{AppHost}/index.html");
    }

    private void OnAppResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = new Uri(e.Request.Uri);
        if (!string.Equals(uri.Host, AppHost, StringComparison.OrdinalIgnoreCase)) return;

        string path = uri.AbsolutePath.TrimStart('/');
        if (string.IsNullOrEmpty(path)) path = "index.html";

        string resourceName = ResourcePrefix + path.Replace('/', '.');
        var asm = Assembly.GetExecutingAssembly();
        var stream = asm.GetManifestResourceStream(resourceName);

        if (stream == null)
        {
            e.Response = Web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }

        e.Response = Web.CoreWebView2.Environment.CreateWebResourceResponse(
            stream, 200, "OK", $"Content-Type: {GetContentType(path)}");
    }

    private static string GetContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".png" => "image/png",
        ".svg" => "image/svg+xml",
        ".ttf" => "font/ttf",
        ".otf" => "font/otf",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
}
