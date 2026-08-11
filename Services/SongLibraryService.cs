using System.IO;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace BeatMapStudio.Services;

public class SongDto
{
    public string Folder { get; set; } = "";
    public string? Title { get; set; }
    public int TrackCount { get; set; }
    public string? AudioUrl { get; set; }
    public string? Subtitle { get; set; }
    public string? CoverUrl { get; set; }
    public int NormalRate { get; set; }
    public bool HasNormal { get; set; }
    public int HardRate { get; set; }
    public bool HasHard { get; set; }
    public bool IsComplete { get; set; }
    public List<string> Missing { get; set; } = new();
}

public class ChartDto
{
    public bool Exists { get; set; }
    public int Rate { get; set; }
    public string Csv { get; set; } = "";
}

/// <summary>
/// Mirrors the filename-convention parsing in MusicCollectionSelection.ReadCustomMusic
/// (Title/TrackCount from audio filename, Subtitle from cover filename, difficulty
/// name + rate from "Normal[n].csv" / "Hard[n].csv"), so folders this service writes
/// are read back by Unity with zero changes on that side.
/// </summary>
public class SongLibraryService
{
    private static readonly Regex NameBeforeBracket = new(@"^[^\[]+", RegexOptions.Compiled);
    private static readonly Regex BracketNumber = new(@"\[(\d+)\]", RegexOptions.Compiled);

    private static readonly HashSet<string> AudioExts = new(StringComparer.OrdinalIgnoreCase) { ".mp3", ".wav" };
    private static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png" };

    public string Root { get; }
    private readonly string _mediaHost;

    public SongLibraryService(string root, string mediaHost)
    {
        Root = root;
        _mediaHost = mediaHost;
        Directory.CreateDirectory(Root);
    }

    private string FolderPath(string folder) => Path.Combine(Root, folder);

    private string MediaUrl(string folder, string fileName) =>
        $"https://{_mediaHost}/{Uri.EscapeDataString(folder)}/{Uri.EscapeDataString(fileName)}?v={DateTime.UtcNow.Ticks}";

    public List<SongDto> ScanSongs()
    {
        var result = new List<SongDto>();
        foreach (var dir in Directory.GetDirectories(Root))
        {
            result.Add(ScanOne(Path.GetFileName(dir)));
        }
        return result.OrderBy(s => s.Title ?? s.Folder, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private SongDto ScanOne(string folder)
    {
        var dto = new SongDto { Folder = folder };
        string dirPath = FolderPath(folder);
        if (!Directory.Exists(dirPath)) return dto;

        foreach (var file in Directory.GetFiles(dirPath))
        {
            string ext = Path.GetExtension(file);
            string nameNoExt = Path.GetFileNameWithoutExtension(file);

            if (AudioExts.Contains(ext))
            {
                dto.Title = NameBeforeBracket.Match(nameNoExt).Value.Trim();
                var m = BracketNumber.Match(nameNoExt);
                dto.TrackCount = m.Success ? int.Parse(m.Groups[1].Value) : 0;
                dto.AudioUrl = MediaUrl(folder, Path.GetFileName(file));
            }
            else if (ImageExts.Contains(ext))
            {
                dto.Subtitle = nameNoExt;
                dto.CoverUrl = MediaUrl(folder, Path.GetFileName(file));
            }
            else if (ext.Equals(".csv", StringComparison.OrdinalIgnoreCase))
            {
                string diffName = NameBeforeBracket.Match(nameNoExt).Value.Trim().ToUpperInvariant();
                var m = BracketNumber.Match(nameNoExt);
                int rate = m.Success ? int.Parse(m.Groups[1].Value) : 0;

                if (diffName == "NORMAL")
                {
                    dto.HasNormal = true;
                    dto.NormalRate = rate;
                }
                else if (diffName == "HARD")
                {
                    dto.HasHard = true;
                    dto.HardRate = rate;
                }
            }
        }

        var missing = new List<string>();
        if (dto.AudioUrl == null) missing.Add("audio");
        if (string.IsNullOrEmpty(dto.Title)) missing.Add("title");
        if (dto.CoverUrl == null) missing.Add("cover");
        if (string.IsNullOrEmpty(dto.Subtitle)) missing.Add("subtitle");
        if (!dto.HasNormal) missing.Add("normal-chart");
        else if (dto.NormalRate <= 0) missing.Add("normal-rate");
        if (!dto.HasHard) missing.Add("hard-chart");
        else if (dto.HardRate <= 0) missing.Add("hard-rate");
        dto.Missing = missing;
        dto.IsComplete = missing.Count == 0;

        return dto;
    }

    public string CreateSong()
    {
        string folder = "song-" + Guid.NewGuid().ToString("N")[..8];
        Directory.CreateDirectory(FolderPath(folder));
        return folder;
    }

    public void DeleteSong(string folder)
    {
        string path = FolderPath(folder);
        if (Directory.Exists(path)) Directory.Delete(path, true);
    }

    private static void DeleteMatching(string dirPath, HashSet<string> exts, string? namePrefixUpper = null)
    {
        foreach (var file in Directory.GetFiles(dirPath))
        {
            string ext = Path.GetExtension(file);
            if (!exts.Contains(ext)) continue;
            if (namePrefixUpper != null)
            {
                string nameNoExt = Path.GetFileNameWithoutExtension(file);
                string diffName = NameBeforeBracket.Match(nameNoExt).Value.Trim().ToUpperInvariant();
                if (diffName != namePrefixUpper) continue;
            }
            File.Delete(file);
        }
    }

    public SongDto ImportAudio(string folder, string sourceFilePath, string title, int trackCount)
    {
        string dirPath = FolderPath(folder);
        Directory.CreateDirectory(dirPath);
        string ext = Path.GetExtension(sourceFilePath).ToLowerInvariant();
        if (!AudioExts.Contains(ext))
            throw new InvalidOperationException("Unsupported audio file type: " + ext);

        DeleteMatching(dirPath, AudioExts);
        string safeTitle = SanitizeFileNamePart(title);
        string dest = Path.Combine(dirPath, $"{safeTitle}[{trackCount}]{ext}");
        File.Copy(sourceFilePath, dest, overwrite: true);
        return ScanOne(folder);
    }

    public SongDto RenameSong(string folder, string newTitle)
    {
        string dirPath = FolderPath(folder);
        string? audioFile = Directory.GetFiles(dirPath)
            .FirstOrDefault(f => AudioExts.Contains(Path.GetExtension(f)));
        if (audioFile == null)
            throw new InvalidOperationException("Import audio before setting a title.");

        string ext = Path.GetExtension(audioFile);
        string nameNoExt = Path.GetFileNameWithoutExtension(audioFile);
        var m = BracketNumber.Match(nameNoExt);
        int trackCount = m.Success ? int.Parse(m.Groups[1].Value) : 0;

        string safeTitle = SanitizeFileNamePart(newTitle);
        string dest = Path.Combine(dirPath, $"{safeTitle}[{trackCount}]{ext}");
        if (!string.Equals(dest, audioFile, StringComparison.OrdinalIgnoreCase))
            File.Move(audioFile, dest, overwrite: true);
        return ScanOne(folder);
    }

    public SongDto SetTrackCount(string folder, int trackCount)
    {
        string dirPath = FolderPath(folder);
        string? audioFile = Directory.GetFiles(dirPath)
            .FirstOrDefault(f => AudioExts.Contains(Path.GetExtension(f)));
        if (audioFile == null)
            throw new InvalidOperationException("Import audio before setting track count.");

        string ext = Path.GetExtension(audioFile);
        string nameNoExt = Path.GetFileNameWithoutExtension(audioFile);
        string title = NameBeforeBracket.Match(nameNoExt).Value.Trim();

        string dest = Path.Combine(dirPath, $"{title}[{trackCount}]{ext}");
        if (!string.Equals(dest, audioFile, StringComparison.OrdinalIgnoreCase))
            File.Move(audioFile, dest, overwrite: true);
        return ScanOne(folder);
    }

    public SongDto ImportCover(string folder, string sourceFilePath, string subtitle)
    {
        string dirPath = FolderPath(folder);
        Directory.CreateDirectory(dirPath);
        string ext = Path.GetExtension(sourceFilePath).ToLowerInvariant();
        if (!ImageExts.Contains(ext))
            throw new InvalidOperationException("Unsupported image file type: " + ext);

        DeleteMatching(dirPath, ImageExts);
        string safeSubtitle = SanitizeFileNamePart(subtitle);
        string dest = Path.Combine(dirPath, $"{safeSubtitle}{ext}");
        File.Copy(sourceFilePath, dest, overwrite: true);
        return ScanOne(folder);
    }

    public SongDto SetSubtitle(string folder, string newSubtitle)
    {
        string dirPath = FolderPath(folder);
        string? coverFile = Directory.GetFiles(dirPath)
            .FirstOrDefault(f => ImageExts.Contains(Path.GetExtension(f)));
        if (coverFile == null)
            throw new InvalidOperationException("Import a cover image before setting a subtitle.");

        string ext = Path.GetExtension(coverFile);
        string safeSubtitle = SanitizeFileNamePart(newSubtitle);
        string dest = Path.Combine(dirPath, $"{safeSubtitle}{ext}");
        if (!string.Equals(dest, coverFile, StringComparison.OrdinalIgnoreCase))
            File.Move(coverFile, dest, overwrite: true);
        return ScanOne(folder);
    }

    private static string ChartFileName(string difficulty, int rate) =>
        $"{ToDifficultyDisplayName(difficulty)}[{rate}].csv";

    private static string ToDifficultyDisplayName(string difficulty) =>
        difficulty.Equals("Hard", StringComparison.OrdinalIgnoreCase) ? "Hard" : "Normal";

    public ChartDto LoadChart(string folder, string difficulty)
    {
        string dirPath = FolderPath(folder);
        string wantUpper = ToDifficultyDisplayName(difficulty).ToUpperInvariant();
        string? csvFile = Directory.Exists(dirPath)
            ? Directory.GetFiles(dirPath, "*.csv")
                .FirstOrDefault(f => NameBeforeBracket.Match(Path.GetFileNameWithoutExtension(f))
                    .Value.Trim().ToUpperInvariant() == wantUpper)
            : null;

        if (csvFile == null)
            return new ChartDto { Exists = false, Rate = 0, Csv = "" };

        var m = BracketNumber.Match(Path.GetFileNameWithoutExtension(csvFile));
        int rate = m.Success ? int.Parse(m.Groups[1].Value) : 0;
        return new ChartDto { Exists = true, Rate = rate, Csv = File.ReadAllText(csvFile) };
    }

    public ChartDto SaveChart(string folder, string difficulty, int rate, string csv)
    {
        string dirPath = FolderPath(folder);
        string dest = Path.Combine(dirPath, ChartFileName(difficulty, rate));
        try
        {
            Directory.CreateDirectory(dirPath);
            DeleteMatching(dirPath, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".csv" },
                ToDifficultyDisplayName(difficulty).ToUpperInvariant());
            File.WriteAllText(dest, csv, System.Text.Encoding.UTF8);
        }
        catch (IOException)
        {
            // By far the most common cause here is another process (an editor, a sync
            // client, antivirus scan, etc.) holding the file open — surface that plainly
            // instead of letting a raw "The process cannot access the file..." through.
            throw new InvalidOperationException("保存失败：文件被占用，或其他原因导致无法写入");
        }
        catch (UnauthorizedAccessException)
        {
            throw new InvalidOperationException("保存失败：没有权限写入该文件，请检查文件/文件夹权限");
        }
        return new ChartDto { Exists = true, Rate = rate, Csv = csv };
    }

    private static string SanitizeFileNamePart(string name)
    {
        string trimmed = name.Trim();
        if (trimmed.Length == 0) trimmed = "untitled";
        foreach (char c in Path.GetInvalidFileNameChars().Concat(new[] { '[', ']' }))
            trimmed = trimmed.Replace(c, '_');
        return trimmed;
    }
}
